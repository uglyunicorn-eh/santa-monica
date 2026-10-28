# Credits

Santa Monica, the API behind [Anonymous Santa Clauses](https://gnomik.me), is built on open-source software. Thank you to
everyone who makes it.

The MIT license in [LICENSE](LICENSE) covers this project's own code. Each library below keeps its own license.

## In production

These libraries are bundled into the Worker that runs the API.

| Library | What it does here | License | Copyright |
| --- | --- | --- | --- |
| [Hono](https://hono.dev) | Routing and middleware | MIT | © 2021–present Yusuke Wada and Hono contributors |
| [jose](https://github.com/panva/jose) | Signing and checking sign-in tokens (JWT) | MIT | © 2018 Filip Skokan |
| [Valibot](https://valibot.dev) | Checking request input | MIT | © Fabian Hiller |

## For development

Used to build, test and deploy the API. None of it ships with the Worker.

| Tool | What it does here | License | Copyright |
| --- | --- | --- | --- |
| [Wrangler](https://github.com/cloudflare/workers-sdk) | Local development and deploys | MIT or Apache-2.0 | © Cloudflare, Inc. |
| [Workers types](https://github.com/cloudflare/workerd) | TypeScript types for the Workers runtime | MIT or Apache-2.0 | © Cloudflare, Inc. |
| [Workers Vitest integration](https://github.com/cloudflare/workers-sdk/tree/main/packages/vitest-plugin) | Running tests inside the Workers runtime | MIT | © Cloudflare, Inc. |
| [Vitest](https://vitest.dev) | Tests, and coverage (`@vitest/coverage-istanbul`) | MIT | © 2021–present VoidZero Inc. and Vitest contributors |
| [Vite](https://vite.dev) | Used by Vitest | MIT | © 2019–present VoidZero Inc. and Vite contributors |
| [TypeScript](https://www.typescriptlang.org) | Type checking | Apache-2.0 | © Microsoft Corporation |
| [Node.js types](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) | TypeScript types for Node.js APIs | MIT | © Microsoft Corporation |

Their own dependencies are listed in `package-lock.json`, each with its license.
