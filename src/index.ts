import { AnyVariables, Exchange, TypedDocumentNode } from '@urql/core';
import {
  ASTNode,
  buildClientSchema,
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
import { DocumentNode, isNode } from 'graphql/language/ast';
import { map, pipe } from 'wonka';

type ScalarMapping = (input: any) => any;

interface ScalarWithPath {
  /**
   * The name of the scalar
   */
  name: string;
  /**
   * The path to the scalar in the data returned from the server
   */
  path: PropertyKey[];
}

interface ScalarInNode extends ScalarWithPath {
  kind: 'scalar';
}
interface FragmentInNode {
  kind: 'fragment';
  fragmentName: string;
  path: PropertyKey[];
}
type NodeWithPath = ScalarInNode | FragmentInNode;

function traverseAncestors(
  astPath: ReadonlyArray<number | string>,
  ancestorAstNodes: ReadonlyArray<ASTNode | readonly ASTNode[]>,
  callback: (node: ASTNode) => void
): void {
  let currentAstNode = ancestorAstNodes[0];
  astPath.forEach(segment => {
    // @ts-expect-error
    currentAstNode = currentAstNode[segment];
    if (isNode(currentAstNode)) {
      callback(currentAstNode);
    }
  });
}

function getPathAndFragmentName(
  astPath: ReadonlyArray<number | string>,
  ancestorAstNodes: ReadonlyArray<ASTNode | readonly ASTNode[]>
): [PropertyKey[], string | undefined] {
  const path: PropertyKey[] = [];
  let fragmentName: string | undefined;
  traverseAncestors(astPath, ancestorAstNodes, node => {
    if (node.kind === Kind.FIELD) {
      if (node.alias) {
        path.push(node.alias.value);
      } else {
        path.push(node.name.value);
      }
    } else if (node.kind === Kind.FRAGMENT_DEFINITION) {
      fragmentName = node.name.value;
    }
  });

  return [path, fragmentName];
}

function mapScalar(data: any, path: PropertyKey[], mapping: ScalarMapping) {
  if (data == null) {
    return data;
  }

  const newData = { ...data };

  let newSubData = newData;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(newSubData[segment])) {
      const subPath = path.slice(index + 1);
      newSubData[segment] = newSubData[segment].map((subData: unknown) =>
        mapScalar(subData, subPath, mapping)
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
    newSubData[finalSegment] = newSubData[finalSegment].map(mapping);
  } else if (newSubData[finalSegment] != null) {
    newSubData[finalSegment] = mapping(newSubData[finalSegment]);
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

function handleNever(value: never): never {
  return value;
}

export default function scalarExchange({
  schema,
  scalars,
}: ScalarExchangeOptions): Exchange {
  const clientSchema = buildClientSchema(schema);
  const typeInfoInstance = new TypeInfo(clientSchema);

  const getScalarsInQuery = (
    query: DocumentNode | TypedDocumentNode<any, AnyVariables>
  ): ScalarWithPath[] => {
    const nodesInQuery: NodeWithPath[] = [];
    // Keyed by fragment name.
    const nodesInFragments: Record<string, NodeWithPath[]> = {};

    const visitor = visitWithTypeInfo(typeInfoInstance, {
      Field(_node, _key, _parent, astPath, ancestorAstNodes) {
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

        const [path, fragmentName] = getPathAndFragmentName(
          astPath,
          ancestorAstNodes
        );

        const scalarInNode: ScalarInNode = { kind: 'scalar', name, path };
        if (fragmentName == null) {
          nodesInQuery.push(scalarInNode);
        } else {
          nodesInFragments[fragmentName] = nodesInFragments[fragmentName] ?? [];
          nodesInFragments[fragmentName].push(scalarInNode);
        }
      },
      FragmentSpread(node, _key, _parent, astPath, ancestorAstNodes) {
        const [path, fragmentName] = getPathAndFragmentName(
          astPath,
          ancestorAstNodes
        );

        const fragmentInNode: FragmentInNode = {
          kind: 'fragment',
          fragmentName: node.name.value,
          path,
        };
        if (fragmentName == null) {
          nodesInQuery.push(fragmentInNode);
        } else {
          nodesInFragments[fragmentName] = nodesInFragments[fragmentName] ?? [];
          nodesInFragments[fragmentName].push(fragmentInNode);
        }
      },
    });
    visit(query, visitor);

    // Keyed by fragment name.
    const resolvedScalarsInFragments: Record<string, ScalarWithPath[]> = {};
    const resolveScalarsInFragment = (
      fragmentName: string,
      visitedFragmentNames: string[] = []
    ): ScalarWithPath[] => {
      if (resolvedScalarsInFragments[fragmentName]) {
        return resolvedScalarsInFragments[fragmentName];
      }

      if (visitedFragmentNames.includes(fragmentName)) {
        // There's a cycle in the nested fragments; we should do something here but not error (because it's technically legal).
        return [];
      }

      const scalarsInFragment: ScalarWithPath[] = [];
      nodesInFragments[fragmentName].forEach(nodeWithPath => {
        if (nodeWithPath.kind === 'scalar') {
          scalarsInFragment.push(nodeWithPath);
        } else if (nodeWithPath.kind === 'fragment') {
          const newScalars: ScalarWithPath[] = resolveScalarsInFragment(
            nodeWithPath.fragmentName,
            [...visitedFragmentNames, fragmentName]
          ).map(scalarWithPath => ({
            ...scalarWithPath,
            path: [...nodeWithPath.path, ...scalarWithPath.path],
          }));
          scalarsInFragment.push(...newScalars);
        } else {
          handleNever(nodeWithPath);
        }
      });
      resolvedScalarsInFragments[fragmentName] = scalarsInFragment;
      return scalarsInFragment;
    };

    const scalarsInQuery: ScalarWithPath[] = [];
    nodesInQuery.forEach(nodeWithPath => {
      if (nodeWithPath.kind === 'scalar') {
        scalarsInQuery.push(nodeWithPath);
      } else if (nodeWithPath.kind === 'fragment') {
        const newScalars: ScalarWithPath[] = resolveScalarsInFragment(
          nodeWithPath.fragmentName
        ).map(scalarWithPath => ({
          ...scalarWithPath,
          path: [...nodeWithPath.path, ...scalarWithPath.path],
        }));
        scalarsInQuery.push(...newScalars);
      } else {
        handleNever(nodeWithPath);
      }
    });
    return scalarsInQuery;
  };

  return ({ forward }) => (operations$: any) => {
    const operationResult$ = forward(operations$);
    return pipe(
      operationResult$,
      map(args => {
        if (args.data == null) {
          return args;
        }

        const scalarsInQuery = getScalarsInQuery(args.operation.query);
        if (scalarsInQuery.length === 0) {
          return args;
        }

        scalarsInQuery.forEach(({ name, path }) => {
          args.data = mapScalar(args.data, path, scalars[name]);
        });
        return args;
      })
    );
  };
}
