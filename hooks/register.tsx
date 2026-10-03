export function register(on) {
  on('tool.call', async ($, e, next) => next(e))
}
