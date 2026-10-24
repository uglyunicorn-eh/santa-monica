export type NodeKind = 'User' | 'Party';

export interface INodeId {
  kind: string;
  id: string;
}

export function strToNodeId(str: string): INodeId {
  const errorMsg = `String "${str}" is not a valid Node ID.`;
  try {
    const decoded = atob(str);
    const separator = decoded.indexOf(':');
    const [kind, id] = [decoded.slice(0, separator), decoded.slice(separator + 1)];
    if (separator < 1 || !id) {
      throw new Error(errorMsg);
    }
    return { kind, id };
  } catch {
    throw new Error(errorMsg);
  }
}

export function nodeIdToStr({ kind, id }: INodeId) {
  return btoa(`${kind}:${id}`);
}
