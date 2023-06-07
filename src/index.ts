import { Exchange } from '@urql/core';
import {
  ASTNode,
  buildClientSchema,
  FieldNode,
  GraphQLOutputType,
  GraphQLScalarType,
  IntrospectionQuery,
  isListType,
  isNonNullType,
  isScalarType,
  Kind,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import { FragmentDefinitionNode, isNode } from 'graphql/language/ast';
import { map, pipe } from 'wonka';

type ScalarMapping = (input: any) => any;

interface ScalarInQuery {
  /**
   * The name of the fragment if the field appeared inside of a fragment
   */
  fragmentName?: string;
  kind: 'Scalar';
  /**
   * The name of the scalar
   */
  name: string;
  /**
   * The path to the scalar in the data returned from the server
   */
  path: PropertyKey[];
}

interface FragmentSpreadInQuery {
  kind: 'FragmentSpread';
  /**
   * The name of the fragment that was spread
   */
  name: string;
  /**
   * The path to the fragment spread in the data returned from the server
   */
  path: PropertyKey[];
}

function makeIsAstNodeOfKind<T extends ASTNode>(kind: ASTNode['kind']) {
  return (
    maybeNodeOrArray: ASTNode | ReadonlyArray<ASTNode>
  ): maybeNodeOrArray is T => {
    if (!isNode(maybeNodeOrArray)) {
      return false;
    }

    return maybeNodeOrArray.kind === kind;
  };
}

const isFieldNode = makeIsAstNodeOfKind<FieldNode>(Kind.FIELD);
const isFragmentDefinition = makeIsAstNodeOfKind<FragmentDefinitionNode>(
  Kind.FRAGMENT_DEFINITION
);

function mapScalar(data: any, path: PropertyKey[], map: ScalarMapping): any {
  if (data == null) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(subData => mapScalar(subData, path, map));
  }

  const newData = { ...data };

  let newSubData = newData;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(newSubData[segment])) {
      const subPath = path.slice(index + 1);
      newSubData[segment] = newSubData[segment].map((subData: unknown) =>
        mapScalar(subData, subPath, map)
      );
      return newData;
    } else if (newSubData[segment] === null) {
      return newData;
    } else {
      newSubData[segment] = { ...newSubData[segment] };
    }
    newSubData = newSubData[segment];
  }

  const finalSegment = path[path.length - 1];

  if (Array.isArray(newSubData[finalSegment])) {
    newSubData[finalSegment] = newSubData[finalSegment].map(map);
  } else if (newSubData[finalSegment] != null) {
    newSubData[finalSegment] = map(newSubData[finalSegment]);
  }

  return newData;
}

interface ScalarExchangeOptions {
  scalars: Record<string, ScalarMapping>;
  schema: IntrospectionQuery;
}

function unpackTypeInner(type: GraphQLOutputType): GraphQLOutputType | void {
  if (isListType(type) || isNonNullType(type)) {
    return unpackTypeInner(type.ofType);
  }

  if (isScalarType(type)) {
    return type;
  }

  return;
}

function unpackType(type: GraphQLOutputType): GraphQLScalarType | void {
  return unpackTypeInner(type) as GraphQLScalarType | void;
}

export default function scalarExchange({
  schema,
  scalars,
}: ScalarExchangeOptions): Exchange {
  const clientSchema = buildClientSchema(schema);
  const typeInfoInstance = new TypeInfo(clientSchema);

  const makeVisitor = (
    nodesOfInterest: Array<ScalarInQuery | FragmentSpreadInQuery>
  ) =>
    visitWithTypeInfo(typeInfoInstance, {
      Field(_node, _key, _parent, astPath, anchestorAstNodes) {
        const fieldType = typeInfoInstance.getType();
        if (fieldType == null) {
          return;
        }

        const scalarType = unpackType(fieldType);
        if (scalarType == null) {
          return;
        }

        const { name } = scalarType;

        if (scalars[name] == null) {
          return;
        }

        let currentAstNode: ASTNode | ReadonlyArray<ASTNode> =
          anchestorAstNodes[0];

        const path: PropertyKey[] = [];
        let fragmentName: string | undefined;
        for (const segment of astPath) {
          // @ts-expect-error
          currentAstNode = currentAstNode[segment];
          if (isFieldNode(currentAstNode)) {
            const fieldNode = currentAstNode as FieldNode;
            if (fieldNode.alias) {
              path.push(fieldNode.alias.value);
            } else {
              path.push(fieldNode.name.value);
            }
          } else if (isFragmentDefinition(currentAstNode)) {
            fragmentName = currentAstNode.name.value;
          }
        }

        nodesOfInterest.push({
          fragmentName,
          kind: 'Scalar',
          name,
          path,
        });
      },
      FragmentSpread(node, _key, _parent, astPath, anchestorAstNodes) {
        let currentAstNode: ASTNode | ReadonlyArray<ASTNode> =
          anchestorAstNodes[0];

        const path: PropertyKey[] = [];
        for (const segment of astPath) {
          // @ts-expect-error
          currentAstNode = currentAstNode[segment];
          if (isFieldNode(currentAstNode)) {
            const fieldNode = currentAstNode as FieldNode;
            if (fieldNode.alias) {
              path.push(fieldNode.alias.value);
            } else {
              path.push(fieldNode.name.value);
            }
          }
        }

        nodesOfInterest.push({
          kind: 'FragmentSpread',
          name: node.name.value,
          path,
        });
      },
    });

  return ({ forward }) => (operations$: any) => {
    const operationResult$ = forward(operations$);
    return pipe(
      operationResult$,
      map(args => {
        if (args.data == null) {
          return args;
        }
        const nodesOfInterest: Array<
          FragmentSpreadInQuery | ScalarInQuery
        > = [];
        visit(args.operation.query, makeVisitor(nodesOfInterest));

        if (nodesOfInterest.length === 0) {
          return args;
        }

        const spreadFragmentsInQuery: Record<
          string,
          FragmentSpreadInQuery[]
        > = {};
        const scalarsInQuery: ScalarInQuery[] = [];

        for (const nodeOfInterest of nodesOfInterest) {
          const { kind } = nodeOfInterest;
          if (kind === 'Scalar') {
            scalarsInQuery.push(nodeOfInterest as ScalarInQuery);
          } else {
            const { name } = nodeOfInterest;
            spreadFragmentsInQuery[name] = spreadFragmentsInQuery[name] ?? [];
            spreadFragmentsInQuery[name].push(
              nodeOfInterest as FragmentSpreadInQuery
            );
          }
        }

        for (const { fragmentName, name, path } of scalarsInQuery) {
          if (fragmentName && spreadFragmentsInQuery[fragmentName]) {
            for (const { path: pathToFragment } of spreadFragmentsInQuery[
              fragmentName
            ]) {
              args.data = mapScalar(
                args.data,
                [...pathToFragment, ...path],
                scalars[name]
              );
            }
          } else {
            args.data = mapScalar(args.data, path, scalars[name]);
          }
        }

        return args;
      })
    );
  };
}
