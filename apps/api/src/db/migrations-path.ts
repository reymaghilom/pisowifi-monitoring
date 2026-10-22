import { fileURLToPath } from "node:url";

/** apps/api/drizzle/ (src/db/ and dist/db/ are both two levels below apps/api/). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
