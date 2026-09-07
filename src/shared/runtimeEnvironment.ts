type Environment = Record<string, string>;
type Lookup = (name: string) => string | undefined;

export function parseEnvironmentVariables(
  raw: string,
  inherited: Environment = {},
  lookup: Lookup = () => undefined,
): Environment {
  const env: Environment = Object.create(null);
  const read = (name: string) =>
    Object.prototype.hasOwnProperty.call(env, name)
      ? env[name]
      : Object.prototype.hasOwnProperty.call(inherited, name)
        ? inherited[name]
        : lookup(name) || "";
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const assignment = text.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/,
    );
    if (!assignment) {
      throw new Error(
        `Invalid environment assignment on line ${index + 1}. Use NAME=value.`,
      );
    }
    const key = assignment[1];
    let value = assignment[2].trim();
    const quote = value[0];
    if (quote === "'" || quote === '"') {
      let end = 1;
      for (; end < value.length; end++) {
        if (quote === '"' && value[end] === "\\") {
          end++;
          continue;
        }
        if (value[end] === quote) break;
      }
      if (end === value.length || !/^(?:\s*#.*)?$/.test(value.slice(end + 1))) {
        throw new Error(
          `Invalid quoted environment value on line ${index + 1}.`,
        );
      }
      value = value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    // Single quotes protect literal dollars in credentials. Double-quoted and
    // unquoted values support PATH=$PATH and escaped dollars without a shell.
    const expansion =
      quote === '"'
        ? /\\([$"\\])|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
        : /\\(\$)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
    env[key] =
      quote === "'"
        ? value
        : value.replace(
            expansion,
            (_match, escaped: string, braced: string, plain: string) =>
              escaped || read(braced || plain),
          );
  }
  return env;
}

export function buildRuntimeEnvironment(
  proxy: string,
  general: string,
  provider = "",
  lookup: Lookup = () => undefined,
): Environment {
  let env: Environment = {};
  const configuredProxy = proxy.trim();
  if (configuredProxy) {
    try {
      const url = new URL(configuredProxy);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      // Do not include the proxy URL: it may contain credentials.
      throw new Error(
        "Invalid proxy URL. Use an HTTP or HTTPS proxy address in Claudero preferences.",
      );
    }
    // A CONNECT proxy need not serve HEAD requests at its own address. Honor
    // the configured proxy and let the actual provider connection report errors.
    env = {
      HTTP_PROXY: configuredProxy,
      HTTPS_PROXY: configuredProxy,
      NO_PROXY: "localhost,127.0.0.1,::1",
    };
  }
  env = { ...env, ...parseEnvironmentVariables(general, env, lookup) };
  return { ...env, ...parseEnvironmentVariables(provider, env, lookup) };
}
