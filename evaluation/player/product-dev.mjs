// Reuse the existing two-service launcher with the actual product entry point.
process.env.EVALUATION_FRONTEND = 'product';
await import('./dev.mjs');
