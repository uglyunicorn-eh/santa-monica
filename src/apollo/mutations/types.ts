export type CreatePartyInput = {
  name: string;
  password?: string;
}

export type JoinPartyInput = {
  party: string;
  name: string;
  password?: string;
}

export type LeavePartyInput = {
  party: string;
}

export type ClosePartyInput = {
  party: string;
}

export type EnterRequestInput = {
  email: string;
  party: string;
}

export type EnterInput = {
  enterRequestToken: string;
}
