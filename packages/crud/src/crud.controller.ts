import type { NextFunction, Request, Response } from "express";
import type { IRequestContext } from "monolite-core";
import { AppError } from "monolite-core";
import { BaseController, parseId } from "monolite-http";
import type { ICrudBLL, ListOptions } from "./crud.bll.js";

/**
 * One of the five handlers, and the type an override should carry.
 *
 * `CrudController` declares its handlers as property arrow functions — that is
 * what keeps `this` bound without a `.bind()` in the router, and it is why the
 * route decorators are written for properties rather than for prototype
 * methods. The cost is that an override has to match the property's type
 * exactly, down to `Promise<void>` and the full Express generics, and both
 * documented examples of overriding a verb tripped over it.
 *
 * Naming the type is what removes that: `public override create: CrudHandler =
 * async (req, res, next) => ...` infers all three parameters, so the override
 * says what it does and nothing about the shape of Express.
 */
export type CrudHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

/** The HTTP contract `@Crud()` mounts. A module may replace any of them. */
export interface ICrudController {
  list(req: Request, res: Response, next: NextFunction): Promise<void>;
  getOne(req: Request, res: Response, next: NextFunction): Promise<void>;
  create(req: Request, res: Response, next: NextFunction): Promise<void>;
  update(req: Request, res: Response, next: NextFunction): Promise<void>;
  softDelete(req: Request, res: Response, next: NextFunction): Promise<void>;
}

/** The query the listing understands without the module translating it. */
interface PagedQuery {
  page?: number;
  limit?: number;
  withDeleted?: boolean;
}

/**
 * What the CRUD reads off the request on top of Express's own fields.
 *
 * The query validator in `monolite-http` leaves the parsed query in
 * `validatedQuery` and declares the property on Express's `Request` by
 * declaration merging. Going through this intersection rather than leaning on
 * that ambient declaration keeps the CRUD compiling on its own, whatever subset
 * of the HTTP package the consumer happens to pull in.
 */
type CrudRequest = Request & { validatedQuery?: unknown };

/**
 * The `:id` of the path, as `parseId` wants it.
 *
 * Express 5 allows a path parameter to repeat, so its declared type is
 * `string | string[]`. A repeated `:id` is not an id, and turning it into
 * `undefined` here hands it the same 400 that `/users/abc` gets, from the same
 * place — rather than silently querying for `"1,2"`.
 */
function idParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The five handlers of a CRUD over HTTP, written once.
 *
 * This is where everything each controller used to repeat verbatim lives: the
 * `try/catch` that defers to the global handler, the `parseId` that turns
 * `/users/abc` into a 400 instead of an absurd query, the 404 when there is no
 * row, and the status code of each verb.
 *
 * The **routes** are not declared here but with `@Crud()` on the concrete
 * class. A decorator placed on this base would register itself under the base's
 * name rather than the module's, and besides, which verbs are exposed has to be
 * a per-module choice.
 */
export abstract class CrudController extends BaseController implements ICrudController {
  protected constructor(
    private readonly service: ICrudBLL<unknown>,
    context: IRequestContext,
    /** The resource's name in the messages: "no user found with that id". */
    protected readonly resource: string
  ) {
    super(context);
  }

  /**
   * Translates what the route's schema already validated.
   *
   * The whole query goes down to the service: pagination is what this
   * controller understands, and the rest — a search, a filter of its own — is
   * interpreted by `CrudBLL.buildWhere`, which is where that decision
   * belongs.
   */
  private paging(req: Request): { page: number; limit: number; options: ListOptions } {
    const query = ((req as CrudRequest).validatedQuery as PagedQuery | undefined) ?? {};

    return {
      page: query.page ?? 1,
      limit: query.limit ?? 10,
      options: { withDeleted: query.withDeleted, query },
    };
  }

  private notFound(): AppError {
    return new AppError(`No ${this.resource} found with that id`, 404, true, {
      code: "NOT_FOUND",
    });
  }

  public list: CrudHandler = async (req, res, next) => {
    try {
      const { page, limit, options } = this.paging(req);
      res.json(await this.service.list(page, limit, options));
    } catch (error) {
      next(error);
    }
  };

  public getOne: CrudHandler = async (req, res, next) => {
    try {
      const found = await this.service.get(parseId(idParam(req.params.id), this.resource));
      if (!found) throw this.notFound();

      res.json(found);
    } catch (error) {
      next(error);
    }
  };

  public create: CrudHandler = async (req, res, next) => {
    try {
      // It returns the created resource, not an acknowledgement: the client
      // needs the primary key the database has just generated, and making it
      // ask for that with another GET is one round trip too many.
      res.status(201).json(await this.service.create(req.body));
    } catch (error) {
      next(error);
    }
  };

  public update: CrudHandler = async (req, res, next) => {
    try {
      const id = parseId(idParam(req.params.id), this.resource);
      const updated = await this.service.update(id, req.body);
      if (!updated) throw this.notFound();

      res.json(updated);
    } catch (error) {
      next(error);
    }
  };

  public softDelete: CrudHandler = async (req, res, next) => {
    try {
      const deleted = await this.service.softDelete(parseId(idParam(req.params.id), this.resource));
      if (!deleted) throw this.notFound();

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };
}
