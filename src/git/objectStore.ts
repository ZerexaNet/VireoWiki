import { Buffer } from 'node:buffer';
import { Inflate } from 'pako';
import * as git from 'isomorphic-git';
const GITDIR = '/repo/.git';
function missing(): Error { return Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
/** Request-local quarantine. Only validated, reachable loose objects are persisted. */
export class ObjectStore {
    private files = new Map<string, Buffer>();
    private folders = new Set(['/repo', GITDIR, `${GITDIR}/objects`, `${GITDIR}/objects/pack`]);
    private bytes = 0;
    private reads = 0;
    readonly cache = {};
    constructor(private bucket: R2Bucket, readonly pageId: number) {}
    readonly promises = {
        readFile: async (path: string, options?: any): Promise<any> => {
            let value = this.files.get(path);
            if (!value) {
                const match = path.match(/^\/repo\/\.git\/objects\/([a-f0-9]{2})\/([a-f0-9]{38})$/);
                if (!match) throw missing();
                if (++this.reads > 800) throw new Error('Repository is too large for one request');
                const object = await this.bucket.get(`git/pages/${this.pageId}/objects/${match[1]}${match[2]}`);
                if (!object) throw missing();
                value = Buffer.from(await object.arrayBuffer()); this.files.set(path, value);
            }
            return typeof options === 'string' || options?.encoding ? value.toString(typeof options === 'string' ? options as BufferEncoding : options.encoding) : value;
        },
        writeFile: async (path: string, value: any): Promise<void> => {
            const data = Buffer.from(value);
            this.bytes += data.length;
            if (this.bytes > 16 * 1024 * 1024) throw new Error('Repository object limit exceeded');
            this.files.set(path, data);
        },
        mkdir: async (path: string): Promise<void> => { this.folders.add(path); },
        readdir: async (path: string): Promise<string[]> => [...new Set([...this.files.keys(), ...this.folders].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]))],
        stat: async (path: string): Promise<any> => {
            if (this.folders.has(path)) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mode: 0o40755 };
            const data = await this.promises.readFile(path);
            return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: data.length, mode: 0o100644 };
        },
        lstat: async (path: string): Promise<any> => this.promises.stat(path),
        unlink: async (path: string): Promise<void> => { this.files.delete(path); },
        rmdir: async (path: string): Promise<void> => { this.folders.delete(path); },
        symlink: async (): Promise<never> => { throw new Error('Symlinks are disabled'); },
        readlink: async (): Promise<never> => { throw missing(); },
    };
    get args() { return { fs: this as any, dir: '/repo', gitdir: GITDIR, cache: this.cache }; }
    async blob(content: string) { return git.writeBlob({ ...this.args, blob: Buffer.from(content) }); }
    async tree(blob: string) { return git.writeTree({ ...this.args, tree: [{ mode: '100644', path: 'page.md', oid: blob, type: 'blob' }] }); }
    async snapshot(content: string, parent: string | null, author: string, timestamp: number, message: string) {
        const tree = await this.tree(await this.blob(content));
        return git.writeCommit({ ...this.args, commit: { tree, parent: parent ? [parent] : [],
            author: { name: author.replace(/[<>\r\n]/g, ' '), email: 'wiki@localhost', timestamp, timezoneOffset: 0 },
            committer: { name: 'VireoWiki', email: 'wiki@localhost', timestamp, timezoneOffset: 0 }, message: message.replace(/\0/g, '') } });
    }
    async content(oid: string): Promise<{ text: string; objects: string[] }> {
        const commit = (await git.readCommit({ ...this.args, oid })).commit;
        const tree = (await git.readTree({ ...this.args, oid: commit.tree })).tree;
        if (tree.length !== 1 || tree[0].path !== 'page.md' || tree[0].type !== 'blob' || tree[0].mode !== '100644') throw new Error('The repository must contain only a regular page.md file');
        const blob = await git.readBlob({ ...this.args, oid: tree[0].oid });
        if (blob.blob.length > 512 * 1024) throw new Error('page.md exceeds 512 KiB');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(blob.blob);
        if (text.includes('\0')) throw new Error('Binary files are not supported');
        return { text, objects: [oid, commit.tree, tree[0].oid] };
    }
    async persist(oids: string[]) {
        for (const oid of new Set(oids)) {
            const object = await git.readObject({ ...this.args, oid, format: 'content' });
            // Re-encode each verified object as a loose object; quarantine pack files never become public.
            const written = await git.writeObject({ ...this.args, type: object.type as 'blob' | 'tree' | 'commit' | 'tag', object: object.object as Uint8Array, format: 'content' });
            if (written !== oid) throw new Error('Object identity mismatch');
            const value = await this.promises.readFile(`${GITDIR}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
            await this.bucket.put(`git/pages/${this.pageId}/objects/${oid}`, value);
        }
    }
    async unpack(pack: Uint8Array) {
        if (pack.length < 32 || pack.length > 4 * 1024 * 1024 || Buffer.from(pack.subarray(0, 4)).toString() !== 'PACK') throw new Error('Invalid or oversized pack');
        if (new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8) > 200) throw new Error('Too many pack objects');
        validatePackBounds(pack);
        const trailer = Buffer.from(pack.subarray(pack.length - 20)).toString('hex');
        const checksum = Buffer.from(await crypto.subtle.digest('SHA-1', pack.subarray(0, pack.length - 20))).toString('hex');
        if (trailer !== checksum) throw new Error('Pack checksum mismatch');
        const path = `.git/objects/pack/pack-${trailer}.pack`;
        await this.promises.writeFile(`/repo/${path}`, pack);
        return git.indexPack({ ...this.args, filepath: path });
    }
    async pack(oids: string[]) { return (await git.packObjects({ ...this.args, oids: [...new Set(oids)] })).packfile!; }
}
export async function newCommits(store: ObjectStore, oldOid: string, newOid: string): Promise<string[]> {
    const commits: string[] = []; let cursor = newOid;
    while (cursor !== oldOid) {
        if (commits.length >= 40 || commits.includes(cursor)) throw new Error('Push requires a linear history of at most 40 commits');
        const commit = (await git.readCommit({ ...store.args, oid: cursor })).commit;
        if (commit.parent.length !== 1) throw new Error('Non-fast-forward and merge pushes are disabled');
        commits.push(cursor); cursor = commit.parent[0];
    }
    return commits.reverse();
}

/** Bound inflated object sizes before the Git indexer allocates delta buffers. */
export function validatePackBounds(pack: Uint8Array) {
    let offset = 12, total = 0;
    const count = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8);
    for (let object = 0; object < count; object++) {
        let byte = pack[offset++], size = byte & 15, shift = 4;
        const type = (byte >> 4) & 7;
        while (byte & 128) {
            if (shift > 28 || offset >= pack.length - 20) throw new Error('Invalid object size');
            byte = pack[offset++]; size += (byte & 127) * 2 ** shift; shift += 7;
        }
        if (size > 1024 * 1024 || ![1, 2, 3, 6, 7].includes(type)) throw new Error('Invalid or oversized object');
        if (type === 7) offset += 20;
        if (type === 6) { let value; do { value = pack[offset++]; if (offset >= pack.length - 20) throw new Error('Invalid delta'); } while (value & 128); }
        const inflate: any = new Inflate({ chunkSize: 16384 });
        let inflated = 0; const delta: Uint8Array[] = [];
        inflate.onData = (chunk: Uint8Array) => { if (type === 6 || type === 7) delta.push(chunk); inflated += chunk.length; total += chunk.length; if (inflated > 1024 * 1024 || total > 8 * 1024 * 1024) throw new Error('Inflated pack limit exceeded'); };
        inflate.push(pack.subarray(offset, pack.length - 20), false);
        if (!inflate.ended || inflate.err || inflated !== size || !inflate.strm.next_in) throw new Error('Invalid compressed object');
        if (type === 6 || type === 7) {
            const data = Buffer.concat(delta); let cursor = 0;
            for (let field = 0; field < 2; field++) {
                let value = 0, shift = 0, byte;
                do { if (cursor >= data.length || shift > 28) throw new Error('Invalid delta size'); byte = data[cursor++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
                if (value > 1024 * 1024) throw new Error('Delta result exceeds object limit');
            }
        }
        offset += inflate.strm.next_in;
    }
    if (offset !== pack.length - 20) throw new Error('Unexpected pack data');
}
