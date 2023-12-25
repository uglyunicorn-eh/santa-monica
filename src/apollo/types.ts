export type Node = {
  id: string;
};

export type Party = Node & {
  code: string;
  name: string;
  password: string | null;
  isJoined: boolean;
  isHost: boolean;
  isProtected: boolean;
  isClosed: boolean;
  participantCount: number | null;
  participants: string[] | null;
  target: User | null;
};

export type User = Node & {
  name: string;
};

export type UserError = {
  fieldName: string | null;
  messages: string[];
};

export type MutationPayload = {
  status: 'ok' | 'error';
  userErrors: UserError[] | null;
};

export interface NodeMutationPayload<T extends Node = Node> extends MutationPayload {
  node: T | null;
}

export type MutationInput<T> = {
  input: T;
};
