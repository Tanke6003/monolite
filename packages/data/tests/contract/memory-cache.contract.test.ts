import { MemoryCache } from "monolite-core";
import { runCacheContract } from "monolite-data/testing";

// The in-memory cache is the reference, as the in-memory repository is for the
// repository contract: what passes here is what Redis has to reproduce.
runCacheContract("memory", {
  create: () => new MemoryCache(),
});
