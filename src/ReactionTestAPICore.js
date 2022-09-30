import { createRequire } from "module";
import { URL } from "url";
import hashToken from "@reactioncommerce/api-utils/hashToken.js";
import Logger from "@reactioncommerce/logger";
import Random from "@reactioncommerce/random";
import ReactionAPICore from "./ReactionAPICore.js";
import buildContext from "./util/buildContext.js";

const DEFAULT_MONGO_URL = "mongodb://localhost:27017/test";

const require = createRequire(import.meta.url);
const { gql } = require("apollo-server");

class ReactionTestAPICore {
  constructor(options = {}) {
    try {
      this.reactionNodeApp = new ReactionAPICore({
        rootUrl: "https://shop.fake.site/",
        version: "0.0.0-test",
        ...options
      });
    } catch (error) {
      Logger.error("Failed to initialize a ReactionAPICore instance", error);
    }

    this.mutate = (mutation) => async (variables) => {
      const result = await this.reactionNodeApp.apolloServer.executeOperation({ mutation: gql(mutation), variables });
      if (result.errors) throw result.errors;
      return result.data;
    };

    this.query = (query) => async (variables) => {
      const result = await this.reactionNodeApp.apolloServer.executeOperation({ query: gql(query), variables });
      if (result.errors) throw result.errors;
      return result.data;
    };
  }

  get collections() {
    return this.reactionNodeApp.collections;
  }

  get context() {
    return this.reactionNodeApp.context;
  }

  async createUserAndAccount(user = {}, globalRoles) {
    await this.reactionNodeApp.collections.users.insertOne({
      ...user,
      roles: {
        __global_roles__: ((user.roles || {}).__global_roles__ || []).concat(globalRoles || []) // eslint-disable-line camelcase
      },
      services: {
        resume: {
          loginTokens: []
        }
      }
    });

    const createdAt = new Date();
    await this.reactionNodeApp.collections.Accounts.insertOne({
      ...user,
      createdAt,
      updatedAt: createdAt,
      userId: user._id
    });
  }

  async setLoggedInUser(user = {}) {
    if (!user._id) throw new Error("setLoggedInUser: user must have _id property set");

    const { users } = this.reactionNodeApp.collections;

    const loginToken = Random.id();
    const hashedToken = hashToken(loginToken);

    const existing = await users.findOne({ _id: user._id });
    if (!existing) {
      await this.createUserAndAccount(user);
    }

    // Set the hashed login token on the users document
    await users.updateOne(
      { _id: user._id },
      {
        $push: {
          "services.resume.loginTokens": {
            hashedToken,
            when: new Date()
          }
        }
      }
    );

    this.userId = user._id;

    const dbUser = await users.findOne({ _id: user._id });
    this.reactionNodeApp.context.user = dbUser;
    this.reactionNodeApp.context.userId = user._id;
    this.reactionNodeApp.context.accountId = user._id;
  }

  async clearLoggedInUser() {
    this.userId = null;
    this.reactionNodeApp.context.user = null;
  }

  async publishProducts(productIds) {
    const requestContext = { ...this.reactionNodeApp.context };
    await buildContext(requestContext);
    requestContext.validatePermissions = () => null;
    return this.reactionNodeApp.context.mutations.publishProducts(requestContext, productIds);
  }

  // Keep this in sync with the real `registerPlugin` in `ReactionAPICore`
  async registerPlugin(plugin) {
    return this.reactionNodeApp.registerPlugin(plugin);
  }

  async runServiceStartup() {
    return this.reactionNodeApp.runServiceStartup();
  }

  async start() {
    // Change the default DB name to a unique one so that each test file is sandboxed
    const parsedUrl = new URL(process.env.MONGO_URL || DEFAULT_MONGO_URL);
    parsedUrl.pathname = `/${Random.id()}`;
    this.mongoUrl = parsedUrl.toString();

    // We intentionally do not pass `port` option, which prevents
    // it from starting the actual server. We will use
    // `createTestClient` below instead of an actual server.
    try {
      await this.reactionNodeApp.start({
        mongoUrl: this.mongoUrl,
        port: null,
        shouldInitReplicaSet: true
      });
    } catch (error) {
      Logger.error(error, "Error starting app in ReactionTestAPICore");
      throw error;
    }
  }

  async stop() {
    await this.reactionNodeApp.stop();

    // Delete the temporary database
    await this.reactionNodeApp.connectToMongo({ mongoUrl: this.mongoUrl });
    await this.reactionNodeApp.mongoClient.db().dropDatabase();
    await this.reactionNodeApp.disconnectFromMongo();
  }
}

export default ReactionTestAPICore;
