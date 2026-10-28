// Resolve hook: an extensionless relative import that cannot be found is
// retried with ".ts". Only relative specifiers are touched.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && err?.code === "ERR_MODULE_NOT_FOUND" && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
