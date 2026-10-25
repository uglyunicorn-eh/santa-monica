export const typeDefs = `#graphql

  interface Node {
    id: ID!
  }

  type Query {
    app: App!
    user: User
    party(code: String!): Party
    parties(first: Int = 25): [Party!]
    "The signed-in user's parties, newest first, a page at a time (first: 1 to 100). Null without a session."
    partyHistory(first: Int = 10, after: String): PartyPage
  }

  type Mutation {
    parties: PartiesOpts!
    auth: AuthOpts!
    profile: ProfileOpts!
  }

  type App {
    author: String!
    name: String!
    version: String!
  }

  type User implements Node {
    id: ID!
    name: String!
    "Only for the signed-in user; null for anyone else (such as a party target)."
    email: String
  }

  type PartyPage {
    items: [Party!]!
    "Whether there are more parties after this page."
    hasMore: Boolean!
    "Pass as the after argument to get the next page. Null when the page is empty."
    endCursor: String
  }

  type Party implements Node {
    id: ID!
    name: String!
    password: String
    code: String!
    isJoined: Boolean!
    isHost: Boolean!
    isProtected: Boolean!
    isClosed: Boolean!
    participantCount: Int
    participants: [String!]
    target: User
  }

  enum MutationStatus {
    ok
    error
  }

  type UserError {
    fieldName: String
    messages: [String!]
  }

  interface MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
  }

  type PartiesOpts {
    createParty(input: CreatePartyInput!): CreatePartyPayload!
    joinParty(input: JoinPartyInput!): JoinPartyPayload!
    leaveParty(input: LeavePartyInput!): LeavePartyPayload!
    closeParty(input: ClosePartyInput!): ClosePartyPayload!
    "Deletes an open party nobody else has joined. Only the host can cancel it."
    cancelParty(input: CancelPartyInput!): CancelPartyPayload!
  }

  input CreatePartyInput {
    name: String!
    password: String
  }

  type CreatePartyPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
    node: Party
  }

  input JoinPartyInput {
    party: ID!
    name: String!
    password: String
  }

  type JoinPartyPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
    node: Party
  }

  input LeavePartyInput {
    party: ID!
  }

  type LeavePartyPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
    node: Party
  }

  input ClosePartyInput {
    party: ID!
  }

  type ClosePartyPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
    node: Party
  }

  input CancelPartyInput {
    party: ID!
  }

  type CancelPartyPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
  }

  "updateName, requestAccountDeletion and requestEmailChange need a session; the confirm mutations work from the emailed link alone."
  type ProfileOpts {
    updateName(input: UpdateNameInput!): UpdateNamePayload!
    "Emails a link to <baseUrl>/profile/delete/<token> to the account's address."
    requestAccountDeletion: RequestAccountDeletionPayload!
    "Deletes the account. On status ok the account is gone: clear the stored session token."
    confirmAccountDeletion(input: ConfirmAccountDeletionInput!): ConfirmAccountDeletionPayload!
    "Emails a link to <baseUrl>/profile/email/<token> to the new address, and a notice to the current one."
    requestEmailChange(input: RequestEmailChangeInput!): RequestEmailChangePayload!
    "Moves the account to the new address. Returns a new session token for it; tokens issued before stop working."
    confirmEmailChange(input: ConfirmEmailChangeInput!): ConfirmEmailChangePayload!
  }

  type RequestAccountDeletionPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
  }

  input ConfirmAccountDeletionInput {
    token: String!
  }

  type ConfirmAccountDeletionPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
  }

  input RequestEmailChangeInput {
    email: String!
  }

  type RequestEmailChangePayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
  }

  input ConfirmEmailChangeInput {
    token: String!
  }

  type ConfirmEmailChangePayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
    userToken: String
    user: User
  }

  input UpdateNameInput {
    name: String!
  }

  type UpdateNamePayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
    user: User
  }

  type AuthOpts {
    enterRequest(input: EnterRequestInput!): EnterRequestPayload!
    enter(input: EnterInput!): EnterPayload!
  }

  input EnterRequestInput {
    email: String!
    party: String
  }

  type EnterRequestPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
  }

  input EnterInput {
    enterRequestToken: String!
  }

  type EnterPayload implements MutationPayload {
    status: MutationStatus!
    userErrors: [UserError!]
    userToken: String
    user: User
  }

`;
