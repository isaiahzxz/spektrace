process.env.SPEKTRACE_APPMON_VERIFY_DRIVER = "express";
void import("./verify-ingestion-checkpoint").catch(() => {
  console.error("Express checkpoint could not start; details withheld.");
  process.exitCode = 1;
});
