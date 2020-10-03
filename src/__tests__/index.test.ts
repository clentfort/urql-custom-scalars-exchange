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

it('transforms scalars in a simple object', () => {
  const authorQuery = gql`
    {
      author {
        id
        name
      }
    }
  `;

  const authorQueryData = {
    __typename: 'Query',
    author: { __typename: 'Author', id: '123', name: 'Author' },
  };

  const op = client.createRequestOperation('query', {
    key: 1,
    query: authorQuery,
  });
  const response = jest.fn(
    (forwardOp: Operation): OperationResult => {
      expect(forwardOp.key === op.key).toBeTruthy();

      return {
        operation: forwardOp,
        data: authorQueryData,
      };
    }
  );
  const result = jest.fn();
  const forward: ExchangeIO = ops$ => {
    return pipe(ops$, map(response));
  };

  const scalars = {
    String: jest.fn((text: string) => text),
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
  expect(scalars.String).toHaveBeenCalledWith('Author');
  expect(result).toHaveBeenCalledTimes(1);
});

it('transforms scalars in a list response', () => {
  const todosQuery = gql`
    {
      todos {
        id
        text
      }
    }
  `;

  const todosQueryData = {
    __typename: 'Query',
    todos: [
      { __typename: 'Todo', id: '123', text: 'text1' },
      { __typename: 'Todo', id: '456', text: 'text2' },
    ],
  };

  const op = client.createRequestOperation('query', {
    key: 1,
    query: todosQuery,
  });
  const response = jest.fn(
    (forwardOp: Operation): OperationResult => {
      expect(forwardOp.key === op.key).toBeTruthy();

      return {
        operation: forwardOp,
        data: todosQueryData,
      };
    }
  );
  const result = jest.fn();
  const forward: ExchangeIO = ops$ => {
    return pipe(ops$, map(response));
  };

  const scalars = {
    String: jest.fn((text: string) => text),
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
  expect(scalars.String).toHaveBeenCalledTimes(2);
  expect(result).toHaveBeenCalledTimes(1);
});
