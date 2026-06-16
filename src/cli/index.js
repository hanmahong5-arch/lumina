#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const chokidar = require('chokidar');

const program = new Command();
const rootDir = path.resolve(__dirname, '../../');
const config = require(path.join(rootDir, 'lumina.config.js'));

program
  .name('lumina')
  .description('CLI tool for building the Lumina presentation pipeline (multi-project)')
  .version('3.0.0');

// Build command
program
  .command('build')
  .description('Build the presentation (.pptx) files')
  .option('-a, --all', 'Build all chapters and merge them (default if no chapter specified)')
  .option('-c, --chapter <name>', 'Build a specific chapter (e.g. ch01-core-engine)')
  .option('-P, --project <name>', 'Project to build (see lumina.config.js)', config.defaultProject)
  .option('-l, --list', 'Show the resolved build plan without building')
  .option('-f, --force', 'Force rebuild ignoring the cache')
  .option('-w, --watch', 'Watch for changes and auto-rebuild')
  .action((options) => {
    if (options.watch) {
      startWatchMode(options);
    } else {
      runBuild(options);
    }
  });

// Render Excalidraw command
program
  .command('render')
  .description('Render Excalidraw diagrams to PNG')
  .argument('<dir>', 'Directory containing .excalidraw files')
  .option('-f, --force', 'Force re-render of all diagrams')
  .action((dir, options) => {
    const spinner = ora(`Rendering Excalidraw files in ${chalk.blue(dir)}...`).start();
    const args = [path.join(rootDir, 'render-excalidraw.js'), '--batch', dir];
    if (options.force) args.push('--force');
    
    const result = spawnSync('node', args, { cwd: rootDir, stdio: 'inherit' });
    if (result.status === 0) {
      spinner.succeed('Excalidraw render complete.');
    } else {
      spinner.fail('Excalidraw render failed.');
    }
    process.exit(result.status === 0 ? 0 : 1);
  });

// Validate command
program
  .command('validate')
  .description('Validate HTML slide syntax')
  .option('-P, --project <name>', 'Project to validate (see lumina.config.js)')
  .action((options) => {
    console.log(chalk.cyan('Validating HTML slides...'));
    const vArgs = [path.join(rootDir, 'validate-all.js')];
    if (options.project) vArgs.push(`--project=${options.project}`);
    const result = spawnSync('node', vArgs, { cwd: rootDir, stdio: 'inherit' });
    if (result.status === 0) {
      console.log(chalk.green('All slides are valid!'));
    } else {
      console.log(chalk.red('Validation failed. Check output above.'));
    }
    process.exit(result.status === 0 ? 0 : 1);
  });

// Citation freshness command
program
  .command('cite')
  .description('Verify source-code citations resolve against the pinned upstream source')
  .option('-P, --project <name>', 'Project to check (default: every project with a source)')
  .action((options) => {
    console.log(chalk.cyan('Checking source-code citations...'));
    const cArgs = [path.join(rootDir, 'check-citations.js')];
    if (options.project) cArgs.push(`--project=${options.project}`);
    const result = spawnSync('node', cArgs, { cwd: rootDir, stdio: 'inherit' });
    if (result.status === 0) {
      console.log(chalk.green('All citations resolve.'));
    } else {
      console.log(chalk.red('Citation check found problems (see above).'));
    }
    // Propagate the gate's exit code so `npm run cite` and CI fail on drift.
    process.exit(result.status === 0 ? 0 : 1);
  });

// Studio command
program
  .command('studio')
  .description('Launch Lumina Studio (Live Web Preview)')
  .option('-p, --port <number>', 'Port to run the studio on', '3000')
  .action((options) => {
    console.log(chalk.magenta('🚀 Launching Lumina Studio...'));
    const args = [path.join(rootDir, 'src/studio/server.js'), '--port', options.port];
    const serverProcess = spawn('node', args, { cwd: rootDir, stdio: 'inherit' });
    
    serverProcess.on('error', (err) => {
      console.error(chalk.red(`Failed to start Studio: ${err.message}`));
    });
  });

// Web player command — self-contained interactive deck (build-web.js)
program
  .command('web')
  .description('Build a self-contained interactive web player for a project deck')
  .option('-P, --project <name>', 'Project to build (see lumina.config.js)', config.defaultProject)
  .option('-s, --serve', 'Serve the bundle on a local port after building')
  .option('-p, --port <number>', 'Port for --serve', '5173')
  .action((options) => {
    console.log(chalk.magenta('🎬 Building interactive web player...'));
    const args = [path.join(rootDir, 'build-web.js'), `--project=${options.project}`];
    if (options.serve) { args.push('--serve', `--port=${options.port}`); }
    const result = spawnSync('node', args, { cwd: rootDir, stdio: 'inherit' });
    if (result.status === 0) {
      console.log(chalk.green('✓ Web player ready.'));
    } else {
      console.log(chalk.red('✗ Web build failed (see above).'));
    }
    process.exit(result.status === 0 ? 0 : 1);
  });

function runBuild(options) {
  const projectName = options.project || config.defaultProject;
  if (!config.projects[projectName]) {
    console.error(chalk.red(`Unknown project "${projectName}". Available: ${Object.keys(config.projects).join(', ')}`));
    process.exit(1);
  }

  if (options.chapter) {
    // Single chapter: resolve the project's content root so the chapter dir is found.
    const root = (config.projects[projectName] && config.projects[projectName].root) || '.';
    const spinner = ora(`Building chapter ${chalk.cyan(options.chapter)} ${chalk.gray(`[${projectName}]`)}...`).start();
    const args = [path.join(rootDir, 'build-chapter.js'), options.chapter, `--root=${root}`];
    const result = spawnSync('node', args, { cwd: rootDir, stdio: 'inherit' });

    if (result.status === 0) {
      spinner.succeed(`Successfully built ${options.chapter}`);
    } else {
      spinner.fail(`Failed to build ${options.chapter}`);
    }
  } else {
    // Build all chapters of the selected project
    const spinner = ora(`Building master presentation [${projectName}]...`).start();
    const args = [path.join(rootDir, 'build-all.js'), `--project=${projectName}`];
    if (options.force) args.push('--force');
    if (options.list) args.push('--list');

    // We stream output directly since build-all has its own progress logs
    spinner.stop();
    console.log(chalk.blue.bold('\nStarting Master Build Pipeline...\n'));

    const result = spawnSync('node', args, { cwd: rootDir, stdio: 'inherit' });

    if (result.status === 0) {
      console.log(chalk.green.bold('\n✓ Master Build Complete!'));
    } else {
      console.log(chalk.red.bold('\n✗ Master Build Failed!'));
    }
  }
}

function startWatchMode(options) {
  console.log(chalk.magenta('👁️  Starting Watch Mode...'));
  
  // Initial build
  console.log(chalk.gray('Running initial build...'));
  runBuild(options);
  
  console.log(chalk.magenta('\nWatching for changes in .html and .excalidraw files...'));
  
  const projectName = options.project || config.defaultProject;
  const projectRoot = (config.projects[projectName] && config.projects[projectName].root) || '.';
  const watchBase = path.join(rootDir, projectRoot);
  const watcher = chokidar.watch([
    path.join(watchBase, 'ch*/**/*.html'),
    path.join(watchBase, 'ch*/**/*.excalidraw')
  ], {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true
  });

  let buildTimeout = null;

  watcher.on('change', (filePath) => {
    console.log(chalk.yellow(`\nFile changed: ${path.basename(filePath)}`));
    
    // If it's an excalidraw file, we need to render it first
    if (filePath.endsWith('.excalidraw')) {
      const dir = path.dirname(filePath);
      console.log(chalk.gray(`Rendering diagram...`));
      spawnSync('node', [path.join(rootDir, 'render-excalidraw.js'), '--batch', dir], { cwd: rootDir, stdio: 'inherit' });
    }
    
    // Debounce the build step so we don't trigger 10 builds if saving multiple files
    if (buildTimeout) clearTimeout(buildTimeout);
    buildTimeout = setTimeout(() => {
      console.log(chalk.cyan('Triggering rebuild...'));
      runBuild(options);
      console.log(chalk.magenta('\nWatching for changes...'));
    }, 1000);
  });
}

program.parse(process.argv);
