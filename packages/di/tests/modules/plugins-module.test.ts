import { AsyncRequestContext } from "@monolite/core";
import type { ILogger, IRequestContext } from "@monolite/core";
import { AsyncTransactionContext } from "@monolite/data";
import { container as rootContainer, createContainer, registerPlugins, TOKENS } from "@monolite/di";
import type { IEnvs } from "@monolite/di";
import { envsFrom, silentLogger } from "../support/test-entity";

describe("registerPlugins", () => {
  it("registers the logger it was handed, built", () => {
    const container = createContainer();
    const logger = silentLogger();

    const plugins = registerPlugins({ container, logger });

    expect(container.resolve<ILogger>(TOKENS.ILogger)).toBe(logger);
    expect(plugins.logger).toBe(logger);
  });

  /**
   * One process, one object graph: an application that passes no container
   * wants the global one, and only a test isolating itself passes a child.
   */
  it("registers on the root container when none is given", () => {
    const logger = silentLogger();

    registerPlugins({ logger });

    expect(rootContainer.resolve<ILogger>(TOKENS.ILogger)).toBe(logger);
  });

  it("defaults the request context and the transaction context to the kernel's", () => {
    const container = createContainer();

    const plugins = registerPlugins({ container, logger: silentLogger() });

    expect(plugins.requestContext).toBeInstanceOf(AsyncRequestContext);
    expect(plugins.transactions).toBeInstanceOf(AsyncTransactionContext);
  });

  /**
   * The one that would break silently. The store the HTTP middleware opens has
   * to be the very same one the repository reads three layers down: two
   * instances would mean the audit columns quietly recording nothing.
   */
  it("keeps the ambient contexts to a single instance", () => {
    const container = createContainer();
    registerPlugins({ container, logger: silentLogger() });

    expect(container.resolve(TOKENS.IRequestContext)).toBe(
      container.resolve(TOKENS.IRequestContext)
    );
    expect(container.resolve(TOKENS.ITransactionContext)).toBe(
      container.resolve(TOKENS.ITransactionContext)
    );
  });

  it("takes a replacement context as an instance", () => {
    const container = createContainer();
    const mine: IRequestContext = new AsyncRequestContext();

    const plugins = registerPlugins({ container, logger: silentLogger(), requestContext: mine });

    expect(plugins.requestContext).toBe(mine);
    expect(container.resolve(TOKENS.IRequestContext)).toBe(mine);
  });

  it("takes a replacement context as a class, and builds one of it", () => {
    const container = createContainer();

    const plugins = registerPlugins({
      container,
      logger: silentLogger(),
      requestContext: AsyncRequestContext,
    });

    expect(plugins.requestContext).toBeInstanceOf(AsyncRequestContext);
    expect(container.resolve(TOKENS.IRequestContext)).toBe(plugins.requestContext);
  });

  describe("the environment", () => {
    it("is registered when one was given", () => {
      const container = createContainer();
      const envs = envsFrom({ PORT: "3000" });

      const plugins = registerPlugins({ container, logger: silentLogger(), envs });

      expect(container.resolve<IEnvs>(TOKENS.IEnvs)).toBe(envs);
      expect(plugins.envs).toBe(envs);
    });

    it("leaves the token free for an application that configures itself another way", () => {
      const container = createContainer();

      const plugins = registerPlugins({ container, logger: silentLogger() });

      expect(plugins.envs).toBeUndefined();
      expect(container.isRegistered(TOKENS.IEnvs)).toBe(false);
    });

    /**
     * The hook exists so a missing secret is a start-up error listing what is
     * absent, rather than an application that signs tokens with whatever the
     * default was and is only found out when somebody forges one.
     */
    it("runs the validation, and lets it stop the boot", () => {
      const container = createContainer();
      const envs = envsFrom({});

      expect(() =>
        registerPlugins({
          container,
          logger: silentLogger(),
          envs,
          validate: (source) => {
            if (!source.getEnv("JWT_SECRET")) throw new Error("JWT_SECRET is required");
          },
        })
      ).toThrow("JWT_SECRET is required");
    });

    it("validates after registering, so the hook sees what everything else will", () => {
      const container = createContainer();
      const envs = envsFrom({ JWT_SECRET: "present" });
      const seen: IEnvs[] = [];

      registerPlugins({
        container,
        logger: silentLogger(),
        envs,
        validate: (source) => seen.push(source),
      });

      expect(seen).toEqual([envs]);
      expect(container.resolve(TOKENS.IEnvs)).toBe(envs);
    });

    it("does not validate when there is no environment to validate", () => {
      const validate = jest.fn();
      registerPlugins({ container: createContainer(), logger: silentLogger(), validate });

      expect(validate).not.toHaveBeenCalled();
    });
  });

  describe("the optional passthroughs", () => {
    it("registers a token service when one was given", () => {
      const container = createContainer();
      const tokenService = { sign: () => "", verify: () => ({}) };

      registerPlugins({ container, logger: silentLogger(), tokenService });

      expect(container.resolve(TOKENS.ITokenService)).toBe(tokenService);
    });

    it("registers file storage when it was given", () => {
      const container = createContainer();
      const fileStorage = { save: () => Promise.resolve("") };

      registerPlugins({ container, logger: silentLogger(), fileStorage });

      expect(container.resolve(TOKENS.IFileStorage)).toBe(fileStorage);
    });

    /**
     * Neither is registered by default, and that is the point: the contracts
     * live in packages this one deliberately does not depend on, so an
     * application that uses neither should not inherit an empty binding for
     * both.
     */
    it("leaves both tokens free when neither was given", () => {
      const container = createContainer();

      registerPlugins({ container, logger: silentLogger() });

      expect(container.isRegistered(TOKENS.ITokenService)).toBe(false);
      expect(container.isRegistered(TOKENS.IFileStorage)).toBe(false);
    });
  });
});
