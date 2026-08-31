import { Model, DataTypes } from 'sequelize';

/**
 * A b2bua node announcing itself.
 *
 * Rows are written only by the nodes themselves, once a minute, through the
 * internal heartbeat endpoint — never by a node reaching into this database
 * directly. That distinction matters: the control-plane schema is this
 * service's to own and evolve, and a node that had to be redeployed in step
 * with a column rename would be a migration hazard for no benefit.
 *
 * The table answers two questions.
 *
 * The immediate one is capability: `phone_registrations.b2bua_id` names the
 * node holding a registration, but not what that node *is*. During the
 * migration both stacks run side by side, and only regclient serves the trace
 * and probe API — so a lookup here turns "wait and find out" into "already
 * know", from the very first request.
 *
 * The lasting one is a fleet view: which nodes are up, what they are running,
 * how many registrations each holds and how many of those are failing. Nothing
 * had that before; it was distributed across the rows each node happened to
 * claim.
 */
class B2buaNode extends Model {}

/** How the node identifies its own stack. */
export const B2BUA_NODE_TYPES = ['regclient', 'freeswitch'];

export function initB2buaNode(sequelize, types = DataTypes) {
  B2buaNode.init({
    // The node's public address — the same value it writes into
    // phone_registrations.b2bua_id, which is what makes this table joinable to
    // a registration without anything else being agreed between the two.
    nodeId: {
      type: types.STRING,
      primaryKey: true
    },
    // Where this node answers from inside its own network, when that differs
    // from nodeId. It lives here rather than in phone_registrations.b2bua_id
    // because that column is also read as a SIP gateway address by the LiveKit
    // agent and the pipecat poller — a compound value there would break
    // outbound call routing, where this table is read by nothing that predates
    // it. Null for a node that has no distinct private address, or that
    // predates this field, and the public address is used exactly as before.
    privateAddress: {
      type: types.STRING,
      allowNull: true
    },
    type: {
      type: types.STRING,
      allowNull: false,
      defaultValue: 'regclient'
    },
    version: {
      type: types.STRING,
      allowNull: true
    },
    // Registrations this node currently holds, and how many of them are
    // failing. A node whose failures climb while its total holds steady is a
    // different problem from one that has lost its claims entirely, and the
    // pair says which.
    registrations: {
      type: types.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    failedRegistrations: {
      type: types.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    // One-minute load average, as the node sees it.
    systemLoad: {
      type: types.FLOAT,
      allowNull: true
    },
    // When the node last said it was here. Freshness is the whole signal: a
    // row that has stopped being updated describes a node that has stopped,
    // and is treated as telling us nothing rather than as still true.
    lastSeenAt: {
      type: types.DATE,
      allowNull: false
    }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'B2buaNode',
    tableName: 'b2bua_nodes'
  });

  return B2buaNode;
}

export { B2buaNode };
