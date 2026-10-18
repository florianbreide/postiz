// Stand-in for @prisma/client in the ysocial tests.
//
// The generated Prisma client loads a .env file relative to its own location
// as soon as it is imported (schemaEnvPath "../../../.env" in
// node_modules/.prisma/client). In a worktree whose node_modules is a link to
// the main checkout, that is the .env of the main checkout. The tests never
// talk to a database, so they get this stub and no .env is loaded.
class PrismaClient {}

module.exports = {
  PrismaClient,
  Prisma: {},
};
