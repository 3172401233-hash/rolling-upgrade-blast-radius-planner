/**
 * Tarjan 强连通分量算法，用于发现依赖图中的环路。
 * 处于同一强连通分量的服务无法按拓扑顺序逐个升级，必须并入同一批次。
 */
export function stronglyConnectedComponents(nodes, adjacency) {
  const indexOf = new Map();
  const lowLink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let nextIndex = 0;

  function visit(node) {
    indexOf.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!indexOf.has(neighbor)) {
        visit(neighbor);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        lowLink.set(node, Math.min(lowLink.get(node), indexOf.get(neighbor)));
      }
    }

    if (lowLink.get(node) === indexOf.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component.sort());
    }
  }

  for (const node of nodes) {
    if (!indexOf.has(node)) visit(node);
  }
  return components;
}
