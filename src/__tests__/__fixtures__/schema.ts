import { buildSchema, getIntrospectionQuery, graphql } from 'graphql';
import fs from 'fs';
import path from 'path';

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

  type ParentNested {
    name: String!
    child: Nested!
  }
`);

async function run() {
  console.log('run generator');

  const result = await graphql({
    schema,
    source: getIntrospectionQuery({ descriptions: false }),
  });

  fs.writeFileSync(
    path.join(__dirname, 'schema.json'),
    JSON.stringify(result.data, null, 2)
  );
  console.log('write done');
}

run();

// const root = {
//   simple: () => 'a',
//   nested: () => ({ name: 'a' }),
//   list: () => ['a', 'a'],
//   listNested: () => [{ name: 'a' }, { name: 'a' }],
// };
//
// graphql(schema, ' { list }', root).then(r =>
//   console.log(JSON.stringify(r, null, 2))
// );
