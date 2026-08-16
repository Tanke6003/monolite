import {
  CONTRACT_ENTITY,
  MongoGenericRepository,
  runGenericRepositoryContract,
  type ContractItem,
} from "@monolite/data";
import { FakeMongoDataSource } from "../support/fake-mongo";
import { silentLogger } from "../support/fake-sql-executor";

/**
 * MongoDB is the only engine that shares its implementation with nobody: it does
 * not use `SqlGenericRepository`. Handing it the same suite as the rest is what
 * guarantees that a module written against the contract behaves the same here.
 *
 * The collection double really evaluates the generated queries and rejects any
 * operator the translator should not emit, so what is checked is the actual
 * translation and not an obliging mock.
 */
runGenericRepositoryContract("mongodb", {
  create: () =>
    new MongoGenericRepository<ContractItem>(
      new FakeMongoDataSource(),
      CONTRACT_ENTITY,
      silentLogger
    ),
});
