import {
  IntrospectionQuery,
  buildSchema,
  getIntrospectionQuery,
  graphql,
} from 'graphql';

const schema = buildSchema(/* GraphQL */ `
  type Query {
    simple: String!
    nested: Nested!
    list: [String!]!
    listNested: [Nested!]!
  }

  type Nested {
    name: String!
  }
`);

export default graphql(
  schema,
  getIntrospectionQuery({ descriptions: false })
).then(({ data }) => data as IntrospectionQuery);

// const root = {
//   simple: () => 'a',
//   nested: () => ({ name: 'a' }),
//   list: () => ['a', 'a'],
//   listNested: () => [{ name: 'a' }, { name: 'a' }],
// };

// graphql(schema, ' { list }', root).then(r =>
//   console.log(JSON.stringify(r, null, 2))
// );
