export const typeDefs = `#graphql

  interface Node {
    id: ID!
  }

  type Query {
    app: App!
    user: User
    # node(id: ID!): Node
    # party(code: String!): Party
    # parties(first: Int = 25): [Party!]
  }

  type App {
    author: String!
    name: String!
    version: String!
  }

  type User implements Node {
    id: ID!
    name: String
  }

`;
