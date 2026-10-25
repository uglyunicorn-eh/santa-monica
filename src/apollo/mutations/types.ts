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

export type DeletePartyInput = {
  party: string;
}

export type RestorePartyInput = {
  party: string;
}

export type UpdateNameInput = {
  name: string;
}

export type ConfirmTokenInput = {
  token: string;
}

export type RequestEmailChangeInput = {
  email: string;
}

export type EnterRequestInput = {
  email: string;
  party: string;
}

export type EnterInput = {
  enterRequestToken: string;
}
