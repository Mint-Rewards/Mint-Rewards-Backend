// Runs in every test file (jest.setupFilesAfterEnv), after the test framework
// is installed so afterAll is available.
//
// Route handlers open a Mongoose connection as a side effect of being called —
// delete-account does it before it even authenticates — so a suite can end up
// holding a live connection without ever importing mongoose itself. The driver
// keeps topology heartbeat sockets open, Node never runs out of work, and jest
// hangs after the last test. Registering teardown centrally means a suite that
// touches a connecting route doesn't have to know it did.
const mongoose = require("mongoose");

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});
