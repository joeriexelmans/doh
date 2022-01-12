"use strict";

const { v4: uuidv4 } = require("uuid");

class Operation {
  constructor(id, detail) {
    this.id = id;
    this.detail = detail;
  }
  // Basically replaces JS references by IDs.
  // Result can be JSON'd with constant time+space complexity. Useful for sharing an edit over the network.
  serialize(op) {
    const self = this; // workaround
    return {
      id: this.id,
      detail: Object.fromEntries(
        (function*() {
          for (const [key, {value, parent, depth}] of self.detail.entries()) {
            yield [key, {
              value,
              parentId: parent.id,
              depth,
            }];
          }
        })()),
    }
  }
}

class Context {
  constructor(fetchCallback) {
    // Must be a function taking a single 'id' parameter, returning a Promise resolving to the serialized operation with the given id.
    this.fetchCallback = fetchCallback;

    // "Global" stuff. Operations have GUIDs but can also be shared between Histories. For instance, the 'initial' operation is the common root of all model histories. We could have put these things in a global variable, but that would make it more difficult to mock 'remoteness' (separate contexts) in tests.
    this.initialOp = new Operation("0", new Map()); // The parent of all parentless Operations. Root of all histories.
    this.ops = new Map(); // contains all pending or resolved operation-requests; mapping from operation-id to Promise resolving to Operation.
    this.ops.set(this.initialOp.id, Promise.resolve(this.initialOp));
  }

  // Get a promise resolving to the Operation with given ID. Fetches the operation (and recursively its dependencies) if necessary. Resolves when the operation and all its dependencies are present. Idempotent.
  requestOperation(id) {
    let promise = this.ops.get(id);
    if (promise === undefined) {
      promise = this.fetchCallback(id).then(serialized => this._awaitParents(serialized));
      this.ops.set(id, promise);
    }
    return promise;
  }

  // Similar to requestOperation, but instead the argument is an already fetched/received operation. Missing dependencies are (recursively) fetched, if necessary. Resolves when the operation and all its dependencies are present. Idempotent.
  receiveOperation(serialized) {
    let promise = this.ops.get(serialized.id);
    if (promise === undefined) {
      promise = this._awaitParents(serialized);
      this.ops.set(serialized.id, promise);
    }
    return promise;
  }

  // Internal function. Do not use directly.
  async _awaitParents({id, detail}) {
    const dependencies = Object.entries(detail).map(async ([key, {value, parentId, depth}]) => {
      return [key, {
        value,
        parent: await this.requestOperation(parentId),
        depth,
      }];
    });
    return new Operation(id, new Map(await Promise.all(dependencies)));
  }
}

class History {
  constructor(context, setState, resolve) {
    this.context = context;

    // callbacks
    this.setState = setState;
    this.resolve = resolve;

    this.heads = new Map(); // HEAD ptrs; mapping from key to Operation

    this.ops = new Map(); // Operations (winning and losing) that happened within this History.
    this.ops.set(context.initialOp.id, context.initialOp);

    this.childrenMapping = new Map(); // mapping from operation to object mapping key to current winning child.
  }

  _getHead(key) {
    const op = this.heads.get(key);
    if (op !== undefined) {
      return {
        op,
        depth: op.detail.get(key).depth,
      };
    };
    return {
      op: this.context.initialOp,
      depth: 0,
    };
  }

  _update_head(op) {
    for (const [key, {value}] of op.detail.entries()) {
      this.heads.set(key, op);
    }
  }

  _update_state(op) {
    for (const [key, {value}] of op.detail.entries()) {
      this.setState(key, value);
    }
  }

  _setChild(parent, key, child) {
    let childMap = this.childrenMapping.get(parent);
    if (childMap === undefined) {
      childMap = {};
      this.childrenMapping.set(parent, childMap);
    }
    childMap[key] = child;
  }

  _getChild(parent, key) {
    let childMap = this.childrenMapping.get(parent);
    if (childMap === undefined) return;
    return childMap[key];
  }

  // To be called when a new user operation has happened locally.
  // The new operation advances HEADs.
  new(v, updateState=true) {
    const newId = uuidv4();
    const detail = new Map(Object.entries(v).map(([key,value]) => {
      const {op: parent, depth} = this._getHead(key);
      return [key, {
        value,
        parent,
        depth: depth + 1,
      }];
    }));
    const newOp = new Operation(newId, detail);
    for (const [key, {parent}] of detail.entries()) {
      this._setChild(parent, key, newOp);
    }
    this._update_head(newOp);
    if (updateState) {
      this._update_state(newOp);
    }

    this.context.ops.set(newId, Promise.resolve(newOp));
    this.ops.set(newId, newOp);

    return newOp;
  }

  // Idempotent.
  autoMerge(op) {
    if (this.ops.has(op.id)) {
      // Already merged -> skip
      // console.log('skip (already merged)', op.id)
      return;
    }

    let exec = true;
    for (const [key, {parent}] of op.detail.entries()) {
      if (!this.ops.has(parent.id)) {
        // Update this History with operation's dependencies first
        this.autoMerge(parent);
      }

      // Check if there's a concurrent sibling with whom there is a conflict
      const sibling = this._getChild(parent, key);
      if (sibling) {
        // Conflict
        if (this.resolve(op, sibling)) {
          // console.log("conflict: op wins")
          const visited = new Set();
          const rollback = op => {
            visited.add(op); // Children form a DAG, with possible 'diamond' shapes -> prevent same operation from being visited more than once.
            for (const [key, {parent}] of op.detail.entries()) {
              // recurse, child-first
              const child = this._getChild(op, key);
              if (child && !visited.has(child)) {
                // (DFS) recursion
                rollback(child);
              }
              // rollback
              if (parent === this.context.initialOp) {
                // Invariant: HEADs never contains initialOp
                this.heads.delete(key);
                this.setState(key, undefined);
              } else {
                this.heads.set(key, parent);
                this.setState(key, parent.detail.get(key).value);
              }
            }
          };
          // Received operation wins conflict - state must be rolled back before executing it
          rollback(sibling);
        } else {
          // Received operation loses conflict - nothing to be done
          // console.log("conflict: op loses")
          exec = false;
          continue;
        }
      } else {
        // console.log('no conflict')
      }
      // won (or no conflict):
      this._setChild(parent, key, op);
      if (parent !== this._getHead(key).op) {
        // only execute received operation if it advances HEAD
        exec = false;
      }
    }

    if (exec) {
      this._update_head(op);
      this._update_state(op);
    }

    this.ops.set(op.id, op);
  }

  // Shorthand
  async receiveAndMerge(serializedOp) {
    const op = await this.context.receiveOperation(serializedOp);
    this.autoMerge(op);
    return op;
  }

  // Get operations in history in a sequence, such that any operation's dependencies precede it in the list. To reproduce the state of this History, operations can be executed in the returned order (front to back), and are guaranteed to not give conflicts.
  getOpsSequence() {
    const added = new Set([this.context.initialOp]);
    const visiting = new Set();
    const seq = [];
    const visit = op => {
      if (!added.has(op)) {
        visiting.add(op);
        for (const [key, {parent}] of op.detail.entries()) {
          visit(parent);
        }
        seq.push(op);
        added.add(op);
      }
    }
    for (const op of this.heads.values()) {
      visit(op);
    }
    return seq;
  }
}

module.exports = { Context, History, uuidv4 };
