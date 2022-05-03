import {
  ExchangeIO,
  Operation,
  OperationResult,
  createClient,
} from '@urql/core';
import { IntrospectionQuery } from 'graphql';
import gql from 'graphql-tag';
import { pipe, map, makeSubject, publish, tap } from 'wonka';

import scalarExchange from '../';
import schema from './__fixtures__/schema.json';

const dispatchDebug = jest.fn();

let client = createClient({ url: 'http://0.0.0.0' });
let { source: ops$, next } = makeSubject<Operation>();

beforeEach(() => {
  client = createClient({ url: 'http://0.0.0.0' });
  ({ source: ops$, next } = makeSubject<Operation>());
});

const simpleData = 'a';
const nestedData = { name: 'a' };

const simple = {
  query: gql`
    {
      simple
    }
  `,
  data: { simple: simpleData },
  calls: 1,
};

const nested = {
  query: gql`
    {
      nested {
        name
      }
    }
  `,
  data: { nested: nestedData },
  calls: 1,
};

const nestedNullable = {
  query: gql`
    {
      nestedNullable {
        name
      }
    }
  `,
  data: { nestedNullable: null },
  calls: 0,
};

const list = {
  query: gql`
    {
      list
    }
  `,
  data: { list: [simpleData, simpleData] },
  calls: 2,
};

const listNested = {
  query: gql`
    {
      listNested {
        name
      }
    }
  `,
  data: { listNested: [nestedData, nestedData] },
  calls: 2,
};

const listNestedNullable = {
  query: gql`
    {
      listNestedNullable {
        name
      }
    }
  `,
  data: { listNestedNullable: null },
  calls: 0,
};

const fragment1 = {
  query: gql`
    {
      ...QueryFields
    }

    fragment QueryFields on Query {
      listNested {
        name
      }
    }
  `,
  data: { listNested: [nestedData] },
  calls: 1,
};

const fragment2 = {
  query: gql`
    {
      listNested {
        ...ListFields
      }
    }

    fragment ListFields on Nested {
      name
    }
  `,
  data: { listNested: [nestedData, nestedData] },
  calls: 2,
};

const repeatedFragment = {
  query: gql`
    fragment SomeFragment on Nested {
      name
    }

    {
      first: nested {
        ...SomeFragment
      }

      second: nested {
        ...SomeFragment
      }
    }
  `,
  data: { first: nestedData, second: nestedData },
  calls: 2,
};

const nestedFragment = {
  query: gql`
    query {
      listNested {
        ...nested
      }
    }
    fragment nested on Nested {
      name
      deeplyNested {
        ...nested
      }
    }
  `,
  data: {
    listNested: [
      {
        name: 'firstLevel',
        deeplyNested: {
          name: 'secondLevel',
        },
      },
    ],
  },
  calls: 2,
};

test.each([
  fragment1,
  fragment2,
  list,
  listNested,
  listNestedNullable,
  nested,
  nestedNullable,
  repeatedFragment,
  simple,
  nestedFragment,
])('works on different structures', ({ query, data, calls }) => {
  const op = client.createRequestOperation('query', { key: 1, query });

  const response = jest.fn(
    (forwardOp: Operation): OperationResult => {
      expect(forwardOp.key === op.key).toBeTruthy();
      return {
        operation: forwardOp,
        data: { __typename: 'Query', ...data },
      };
    }
  );
  const result = jest.fn();
  const forward: ExchangeIO = ops$ => pipe(ops$, map(response));

  const scalars = {
    String: jest.fn((text: string) => {
      return text;
    }),
  };

  pipe(
    scalarExchange({
      schema: (schema as unknown) as IntrospectionQuery,
      scalars,
    })({
      forward,
      client,
      dispatchDebug,
    })(ops$),
    tap(result),
    publish
  );

  next(op);

  expect(scalars.String).toHaveBeenCalledTimes(calls);
  expect(result).toHaveBeenCalledTimes(1);
});
