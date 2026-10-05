/** Kept in the document so revisions, Git and MCP preserve the page type together. */
export const DISAMBIGUATION_MARKER = '<!-- vireowiki:disambiguation -->';
const prefix = /^(?:\uFEFF)?[ \t\r\n]*<!-- vireowiki:disambiguation -->[ \t]*(?:\r?\n|$)/;
export function isDisambiguation(content: unknown): boolean {
    return typeof content === 'string' && prefix.test(content);
}
export function stripDisambiguation(content: unknown): string {
    return typeof content === 'string' ? content.replace(prefix, '') : '';
}
export function setDisambiguation(content: string, enabled: boolean): string {
    const body = stripDisambiguation(content);
    return enabled ? DISAMBIGUATION_MARKER + '\n' + body : body;
}
