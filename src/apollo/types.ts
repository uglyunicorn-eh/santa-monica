export type Node = {
  id: string;
}

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
}
