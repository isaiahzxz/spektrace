import {
  exportProjectSnapshot,
  inspectProjectSnapshot,
} from "@/lib/project-snapshot";
async function main() {
  if (process.argv.includes("--check")) {
    const manifest = await inspectProjectSnapshot(process.cwd());
    console.log(
      JSON.stringify({
        files: manifest.files.length,
        exclusions: manifest.exclusions,
        contentReviewStillRequired: true,
      }),
    );
  } else
    console.log(JSON.stringify(await exportProjectSnapshot(process.cwd())));
}
void main().catch(() => {
  console.error("Snapshot export failed; no secret values printed");
  process.exitCode = 1;
});
