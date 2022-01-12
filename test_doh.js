"use strict";

// Should work in browser but only tested with NodeJS v14.16.1

const { Context, History } = require("./History.js");

// From: https://stackoverflow.com/a/43260158
// returns all the permutations of a given array
function perm(xs) {
  let ret = [];

  for (let i = 0; i < xs.length; i = i + 1) {
    let rest = perm(xs.slice(0, i).concat(xs.slice(i + 1)));

    if(!rest.length) {
      ret.push([xs[i]])
    } else {
      for(let j = 0; j < rest.length; j = j + 1) {
        ret.push([xs[i]].concat(rest[j]))
      }
    }
  }
  return ret;
}

// Reinventing the wheel:

class AssertionError extends Error {
  constructor(msg) {
    super(msg);
  }
}
function assert(expr, msg) {
  if (!expr) {
    // console.log(...arguments);
    throw new AssertionError(msg);
  }
}

function deepEqual(val1, val2) {
  if (typeof(val1) !== typeof(val2)) return false;

  if ((val1 === null) !== (val2 === null)) return false;

  switch (typeof(val1)) {
    case 'object':
      for (var p in val2) {
        if (val1[p] === undefined) return false;
      }
      for (var p in val1) {
        if (!deepEqual(val1[p], val2[p])) return false;
      }
      return true;
    case 'array':
      if (val1.length !== val2.length) return false;
      for (let i=0; i<val1.length; ++i)
        if (!deepEqual(val1[i], val2[i])) return false;
      return true;
    default:
      return val1 === val2;
  }
}


// Test:


async function runTest(verbose) {

  function info() {
    if (verbose) console.log(...arguments);
  }

  function resolve(op1, op2) {
    // info("resolve...", props1, props2)
    if (op1.detail.get('geometry').value !== op2.detail.get('geometry').value) {
      return op1.detail.get('geometry').value > op2.detail.get('geometry').value;
    }
    return op1.detail.get('style').value > op2.detail.get('style').value;
  }

  function createAppState(label) {
    const state = {};

    function setState(prop, val) {
      state[prop] = val;
      info("  ", label, "state =", state);
    }
    
    return {setState, state};
  }

  function createHistory(label, context) {
    const {setState, state} = createAppState(label);
    // const context = new Context(requestCallback); // simulate 'remoteness' by creating a new context for every History.

    const history = new History(context, setState, resolve);
    return {history, state};
  }

  {
    info("\nTest case: Add local operations (no concurrency) in random order.\n")

    const local = new Context();

    info("insertions...")
    const {history: expectedHistory, state: expectedState} = createHistory("expected", local);
    const insertions = [
      /* 0: */ expectedHistory.new({geometry: 1, style: 1}),
      /* 1: */ expectedHistory.new({geometry: 2}), // depends on 0
      /* 2: */ expectedHistory.new({style: 2}), // depends on 0
    ];

    const permutations = perm(insertions);
    for (const insertionOrder of permutations) {
      info("permutation...")
      const {history: actualHistory, state: actualState} = createHistory("actual", local);
      // Sequential
      for (const op of insertionOrder) {
        actualHistory.autoMerge(op);
      }
      console.log("expected:", expectedState, "actual:", actualState)
      assert(deepEqual(expectedState, actualState));
    }
  }

  function noFetch() {
    throw new AssertionError("Did not expect fetch");
  }

  {
    info("\nTest case: Multi-user without conflict\n")

    // Local and remote are just names for our histories.
    const localContext = new Context(noFetch);
    const remoteContext = new Context(noFetch);

    const {history: localHistory,  state: localState } = createHistory("local", localContext);
    const {history: remoteHistory, state: remoteState} = createHistory("remote", remoteContext);

    const localOp1 = localHistory.new({geometry: 1});
    await remoteHistory.receiveAndMerge(localOp1.serialize());

    console.log("11")

    const remoteOp2 = remoteHistory.new({geometry: 2}); // happens after (hence, overwrites) op1
    await localHistory.receiveAndMerge(remoteOp2.serialize());

    assert(deepEqual(localState, remoteState));
  }

  {
    info("\nTest case: Concurrency with conflict\n")

    const localContext = new Context(noFetch);
    const remoteContext = new Context(noFetch);

    const {history: localHistory, state: localState} = createHistory("local", localContext);
    const {history: remoteHistory, state: remoteState} = createHistory("remote", remoteContext);

    const localOp1 = localHistory.new({geometry: 1});
    const remoteOp2 = remoteHistory.new({geometry: 2});

    await localHistory.receiveAndMerge(remoteOp2.serialize());
    await remoteHistory.receiveAndMerge(localOp1.serialize());

    assert(deepEqual(localState, remoteState));
  }

  {
    info("\nTest case: Concurrency with conflict (2)\n")

    const localContext = new Context(noFetch);
    const remoteContext = new Context(noFetch);

    const {history: localHistory, state: localState} = createHistory("local", localContext);
    const {history: remoteHistory, state: remoteState} = createHistory("remote", remoteContext);

    info("localHistory insert...")
    const localOp1 = localHistory.new({geometry: 1});
    const localOp2 = localHistory.new({geometry: 4});

    info("remoteHistory insert...")
    const remoteOp3 = remoteHistory.new({geometry: 2});
    const remoteOp4 = remoteHistory.new({geometry: 3});

    info("localHistory receive...")
    await localHistory.receiveAndMerge(remoteOp3.serialize()); // op3 wins from op1 -> op2 and op1 undone
    await localHistory.receiveAndMerge(remoteOp4.serialize()); // buffered

    info("remoteHistory receive...")
    await remoteHistory.receiveAndMerge(((localOp1.serialize()))); // op1 loses from op3
    await remoteHistory.receiveAndMerge(((localOp2.serialize()))); // no conflict

    assert(deepEqual(localState, remoteState));
  }

  {
    info("\nTest case: Fetch\n")

    const fetched = [];

    async function fetchFromLocal(id) {
      // console.log("fetching", id)
      fetched.push(id);
      return localContext.ops.get(id).then(op => op.serialize());
    }

    const localContext = new Context(noFetch);
    const remoteContext = new Context(fetchFromLocal);

    const {history: localHistory, state: localState} = createHistory("local", localContext);

    const localOps = [
      localHistory.new({geometry:1}),                       // [0] (no deps)
      localHistory.new({geometry:2, style: 3}),             // [1], depends on [0]
      localHistory.new({style: 4}),                         // [2], depends on [1]
      localHistory.new({geometry: 5, style: 6, parent: 7}), // [3], depends on [1], [2]
      localHistory.new({parent: 8}),                        // [4], depends on [3]
      localHistory.new({terminal: 9}),                      // [5] (no deps)
    ];

    // when given [2], should fetch [1], then [0]
    await remoteContext.receiveOperation(localOps[2].serialize());
    assert(deepEqual(fetched, [localOps[1].id, localOps[0].id]));

    // when given [5], should not fetch anything
    await remoteContext.receiveOperation(localOps[5].serialize());
    assert(deepEqual(fetched, [localOps[1].id, localOps[0].id]));

    // when given [4], should fetch [3]. (already have [0-2] from previous step)
    await remoteContext.receiveOperation(localOps[4].serialize());
    assert(deepEqual(fetched, [localOps[1].id, localOps[0].id, localOps[3].id]));
  }

  {
    info("\nTest case: Get as sequence\n")

    const {history} = createHistory("local", new Context(noFetch));

    const ops = [
      history.new({x:1, y:1}), // 0
      history.new({x:2}),      // 1 depends on 0
      history.new({y:2}),      // 2 depends on 0
      history.new({x:3, z:3}), // 3 depends on 1
      history.new({a:4}),      // 4
      history.new({a:5}),      // 5 depends on 4
      history.new({a:6, z:6}), // 6 depends on 5, 3
    ];

    const seq = history.getOpsSequence();
    console.log(seq.map(op => op.serialize()));

    assert(seq.indexOf(ops[1]) > seq.indexOf(0));
    assert(seq.indexOf(ops[2]) > seq.indexOf(0));
    assert(seq.indexOf(ops[3]) > seq.indexOf(1));
    assert(seq.indexOf(ops[5]) > seq.indexOf(4));
    assert(seq.indexOf(ops[6]) > seq.indexOf(5));
    assert(seq.indexOf(ops[6]) > seq.indexOf(3));
  }
}

runTest(/* verbose: */ true).then(() => {
  console.log("OK");
}, err => {
  console.log(err);
  process.exit(1);
});
