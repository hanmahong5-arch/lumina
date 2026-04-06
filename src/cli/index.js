#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const chokidar = require('chokidar');

const program = new Command();
const rootDir = path.resolve(__dirname, '../../');

program
  .name('lumina')
  .description('CLI tool for building the Claude Code Lumina presentation pipeline')
  .version('2.0.0');

// Build command
program
  .command('build')
  .description('Build the presentation (.pptx) files')
  .option('-a, --all', 'Build all chapters and merge them (default if no chapter specified)')
  .option('-c, --chapter <name>', 'Build a specific chapter (e.g. ch01-core-engine)')
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
  });

// Validate command
program
  .command('validate')
  .description('Validate HTML slide syntax')
  .action(() => {
    console.log(chalk.cyan('Validating HTML slides...'));
    const result = spawnSync('node', [path.join(rootDir, 'validate-all.js')], { cwd: rootDir, stdio: 'inherit' });
    if (result.status === 0) {
      console.log(chalk.green('All slides are valid!'));
    } else {
      console.log(chalk.red('Validation failed. Check output above.'));
    }
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

function runBuild(options) {
  if (options.chapter) {
    const spinner = ora(`Building chapter ${chalk.cyan(options.chapter)}...`).start();
    const args = [path.join(rootDir, 'build-chapter.js'), options.chapter];
    const result = spawnSync('node', args, { cwd: rootDir, stdio: 'inherit' });
    
    if (result.status === 0) {
      spinner.succeed(`Successfully built ${options.chapter}`);
    } else {
      spinner.fail(`Failed to build ${options.chapter}`);
    }
  } else {
    // Build all
    const spinner = ora('Building master presentation (all chapters)...').start();
    const args = [path.join(rootDir, 'build-all.js')];
    if (options.force) args.push('--force');
    
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
  
  const watcher = chokidar.watch([
    path.join(rootDir, 'ch*/**/*.html'),
    path.join(rootDir, 'ch*/**/*.excalidraw')
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
