export type CreatePartyInput = {
  name: string;
  password?: string;
}

export type JoinPartyInput = {
  party: string;
  password?: string;
}

export type LeavePartyInput = {
  party: string;
}

export type ClosePartyInput = {
  party: string;
}

export type EnterInput = {
  email: string;
  party: string;
}
