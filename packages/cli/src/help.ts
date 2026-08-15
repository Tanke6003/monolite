import { color } from "./util/colors.js";
import { line } from "./util/log.js";
import { engineAliases } from "./config/engines.js";
import { cliVersion } from "./version.js";

const heading = (text: string): string => color.bold(text);
const flag = (text: string): string => color.cyan(text);

export function printRootHelp(): void {
  line();
  line(`${heading("monolite")} ${color.dim(`v${cliVersion()}`)}`);
  line("Scaffolds and extends backend projects built on the monolite toolkit.");
  line();
  line(heading("Usage"));
  line("  monolite <command> [options]");
  line();
  line(heading("Commands"));
  line(`  ${flag("new [name]")}                     Scaffold a new project. Alias: ${flag("init")}`);
  line(`  ${flag("generate <schematic> <name>")}    Add code to an existing project. Alias: ${flag("g")}`);
  line(`  ${flag("help [command]")}                 Show help for a command`);
  line();
  line(heading("Options"));
  line(`  ${flag("-v, --version")}    Print the CLI version`);
  line(`  ${flag("-h, --help")}       Show this help`);
  line(`  ${flag("    --no-color")}   Disable ANSI colour. ${color.dim("NO_COLOR is honoured too")}`);
  line();
  line(heading("Examples"));
  line(color.dim("  monolite new billing-api"));
  line(color.dim("  monolite new billing-api --database=postgres --auth --example --yes"));
  line(color.dim("  monolite generate module invoice"));
  line();
}

export function printNewHelp(): void {
  line();
  line(heading("monolite new [name] [options]"));
  line(`Alias: ${flag("monolite init")}`);
  line();
  line("Scaffolds a new backend project on the @monolite/* packages. Interactive by");
  line("default: every question below also has a flag, and a question whose flag was");
  line(`given is not asked. ${flag("--yes")} answers all of them with their defaults and`);
  line("prompts for nothing, which is what makes the command usable from CI.");
  line();
  line(heading("Arguments"));
  line("  name                        Project name. Defaults to the target directory's name.");
  line();
  line(heading("Project"));
  line(`  ${flag("--directory=<path>")}          Where to write. Default: ./<name>`);
  line(`  ${flag("--project-version=<v>")}       Version of the generated package.json. Default 0.1.0`);
  line(`  ${flag("--description=<text>")}        package.json description and README subtitle`);
  line(`  ${flag("--author=<name>")}             package.json author`);
  line(`  ${flag("--license=<id>")}              SPDX identifier. Default MIT`);
  line(`  ${flag("--api-prefix=<path>")}         Where the API is mounted. Default /api/v1`);
  line();
  line(heading("Database"));
  line(`  ${flag("--database=<engine>")}         ${color.dim(engineAliases().join(", "))}`);
  line(`  ${flag("--db-host=<host>")}            Default localhost`);
  line(`  ${flag("--db-port=<port>")}            Default is the engine's, matching docker-compose.yml`);
  line(`  ${flag("--db-name=<name>")}            Database (Oracle: the service name)`);
  line(`  ${flag("--db-user=<user>")}            Application user`);
  line(color.dim("  There is no --db-password on purpose: the value would land in a committed"));
  line(color.dim("  file. .env.example ships a placeholder and the summary says where to put the"));
  line(color.dim("  real one."));
  line();
  line(heading("Contents"));
  line(`  ${flag("--auth")} / ${flag("--no-auth")}          Add @monolite/auth and a login module`);
  line(`  ${flag("--example")} / ${flag("--no-example")}    Add a sample CRUD module, end to end`);
  line();
  line(heading("Afterwards"));
  line(`  ${flag("--pm=<npm|pnpm|yarn>")}        Package manager. Default npm`);
  line(`  ${flag("--install")} / ${flag("--skip-install")}  Install dependencies. Default: install`);
  line(`  ${flag("--git")} / ${flag("--skip-git")}          Initialise a git repository. Default: yes`);
  line();
  line(heading("Other"));
  line(`  ${flag("--force")}                     Write into a directory that is not empty`);
  line(`  ${flag("-y, --yes")}                   Take every default, ask nothing`);
  line(`  ${flag("-h, --help")}                  Show this help`);
  line();
}

export function printGenerateHelp(): void {
  line();
  line(heading("monolite generate <schematic> <name> [options]"));
  line(`Alias: ${flag("monolite g")}`);
  line();
  line("Adds code to an existing monolite project. The project is found by walking up");
  line("from the working directory looking for a `monolite` key in package.json, so the");
  line("command works from any subdirectory — and refuses to run outside a project.");
  line();
  line(heading("Schematics"));
  line(`  ${flag("module")}       Entity + store registration + service + controller, wired with @Crud`);
  line(`  ${flag("entity")}       Domain interface and its table mapping`);
  line(`  ${flag("service")}      CrudService subclass for an existing entity`);
  line(`  ${flag("controller")}   CrudController subclass for an existing service`);
  line();
  line(heading("Options"));
  line(`  ${flag("--force")}      Overwrite files that already exist`);
  line(`  ${flag("-h, --help")}   Show this help`);
  line();
  line(heading("Examples"));
  line(color.dim("  monolite generate module invoice"));
  line(color.dim("  monolite g entity payment-method"));
  line();
}
