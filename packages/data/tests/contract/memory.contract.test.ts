import {
  CONTRACT_ENTITY,
  MemoryGenericRepository,
  runGenericRepositoryContract,
  type ContractItem,
} from "@monolite/data";

// The in-memory driver is the reference: if the suite passes here, it defines
// what the other engines have to reproduce.
runGenericRepositoryContract("memory", {
  create: () => new MemoryGenericRepository<ContractItem>(CONTRACT_ENTITY, []),
});
