import { Buffer } from 'node:buffer';
export const ZERO = '0'.repeat(40);
export const OID = /^[0-9a-f]{40}$/;
export const REF = 'refs/heads/main';
export function packet(value: string | Uint8Array): Buffer {
    const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    if (data.length > 65516) throw new Error('Packet too large');
    return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
export function parsePackets(data: Uint8Array): { lines: string[]; rest: Buffer } {
    const input = Buffer.from(data), lines: string[] = [];
    let offset = 0;
    while (offset + 4 <= input.length) {
        const prefix = input.subarray(offset, offset + 4).toString();
        if (!/^[0-9a-fA-F]{4}$/.test(prefix)) throw new Error('Invalid packet');
        const length = parseInt(prefix, 16); offset += 4;
        if (length === 0) return { lines, rest: input.subarray(offset) };
        if (length < 4 || length > 65520 || offset + length - 4 > input.length) throw new Error('Truncated packet');
        lines.push(input.subarray(offset, offset + length - 4).toString()); offset += length - 4;
        if (lines.length > 4096) throw new Error('Too many packets');
    }
    throw new Error('Missing flush packet');
}
export function parseUpdate(data: Uint8Array) {
    const { lines, rest } = parsePackets(data);
    if (lines.length !== 1) throw new Error('Exactly one branch update is supported');
    const [command, capabilities = ''] = lines[0].split('\0');
    const [oldOid, newOid, ref, extra] = command.trim().split(' ');
    if (!OID.test(oldOid) || !OID.test(newOid) || extra) throw new Error('Invalid reference update');
    if (ref !== REF || oldOid === ZERO || newOid === ZERO) throw new Error('Branch creation, deletion and other references are disabled');
    if (capabilities.trim().split(/\s+/).some(c => !['report-status', 'ofs-delta', 'agent=git', ''].includes(c) && !c.startsWith('agent='))) throw new Error('Unsupported push capability');
    return { oldOid, newOid, ref, pack: rest };
}
export function advertisement(head: string, service: string, shallow: string | null = null) {
    const caps = service === 'git-upload-pack' ? 'ofs-delta shallow symref=HEAD:refs/heads/main' : 'report-status ofs-delta';
    return Buffer.concat([packet(`# service=${service}\n`), Buffer.from('0000'),
        packet(`${head} ${service === 'git-upload-pack' ? 'HEAD' : REF}\0${caps}\n`),
        ...(service === 'git-upload-pack' ? [packet(`${head} ${REF}\n`)] : []), ...(shallow && service === 'git-upload-pack' ? [packet(`shallow ${shallow}\n`)] : []), Buffer.from('0000')]);
}
export function status(ok: boolean, message = 'rejected') {
    const safe = message.replace(/[\r\n\0]/g, ' ').slice(0, 350);
    return Buffer.concat([packet('unpack ok\n'), packet(`${ok ? 'ok' : 'ng'} ${REF}${ok ? '' : ' ' + safe}\n`), Buffer.from('0000')]);
}
