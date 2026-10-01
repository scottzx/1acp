import nativeTest from "node:test";

/** Local runs retain the complete suite. CI partitions registration order,
 * including loop-generated names, while leaving each test's subtests together. */
const shard = process.env.ACP_INTEGRATION_SHARD;
let integrationTest = nativeTest;
if (shard !== undefined) {
  const match = /^(\d+)\/(\d+)$/u.exec(shard);
  if (!match) {
    throw new Error(`Invalid ACP_INTEGRATION_SHARD: ${shard}`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index < 1 || count < 1 || index > count) {
    throw new Error(`Invalid ACP_INTEGRATION_SHARD: ${shard}`);
  }
  let registered = 0;
  integrationTest = new Proxy(nativeTest, {
    apply(target, thisArg, args: unknown[]) {
      const selected = registered++ % count === index - 1;
      return Reflect.apply(selected ? target : target.skip, thisArg, args);
    },
  });
}

export default integrationTest;
