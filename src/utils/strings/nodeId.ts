import { ObjectId } from 'bson';

import { atob, btoa } from '.';
import { INodeId } from "src/utils/nodeId";

export function strToNodeId(str: string): INodeId {
  const errorMsg = `String "${str}" is not a valid Node ID.`;
  try {
    const [kind, id] = atob(str).split(':', 2);
    if (!kind || !id) {
      throw new Error(errorMsg);
    }
    return { kind, id: ObjectId.createFromHexString(id) };
  } catch {
    throw new Error(errorMsg);
  }
}

export function nodeIdToStr({ kind, id }: INodeId) {
  return btoa(`${kind}:${id}`);
}
