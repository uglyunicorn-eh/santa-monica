export const typeDefs = `#graphql

  interface Node {
    id: ID!
  }

  type Query {
    app: App!
    user: User
    party(code: String!): Party
    parties(first: Int = 25): [Party!]
  }

  type Mutation {
    parties: PartiesOpts!
    auth: AuthOpts!
  }

  type App {
    author: String!
    name: String!
    version: String!
  }

  type User implements Node {
    id: ID!
    name: String!
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
