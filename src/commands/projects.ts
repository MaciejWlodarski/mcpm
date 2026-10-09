import pc from 'picocolors';
import path from 'path';
import {
  findProjectRoot,
  forgetProject,
  listProjects,
  resolveProjectRoot,
  setActiveProject
} from '../projects.js';

export async function useCommand(reference: string) {
  const project = await setActiveProject(reference);
  console.log(pc.green(`Active MCPM project: ${pc.bold(project.name)} (${project.path})`));
  const localRoot = await findProjectRoot();
  if (localRoot && localRoot !== project.path) {
    console.warn(pc.yellow(
      `Warning: local project ${localRoot} takes precedence in the current directory. ` +
      'Move outside it to use the globally active project.'
    ));
  }
  return project;
}

export async function currentCommand() {
  const projectRoot = await resolveProjectRoot();
  const registered = (await listProjects()).find(project => project.path === projectRoot);
  console.log(pc.green(
    `Current MCPM project: ${pc.bold(registered?.name || path.basename(projectRoot))} (${projectRoot})`
  ));
  return { name: registered?.name || null, path: projectRoot };
}

export async function projectsCommand() {
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log(pc.yellow('No MCPM projects are registered.'));
    return [];
  }

  console.log(pc.bold('Registered MCPM projects:'));
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    const marker = project.active ? pc.green('●') : ' ';
    const availability = project.available ? '' : pc.red(' (unavailable)');
    console.log(`  ${marker} ${pc.cyan(project.name)}  ${project.path}${availability}`);
  }
  return projects;
}

export async function forgetCommand(reference: string) {
  const project = await forgetProject(reference);
  console.log(pc.green(
    `Removed project "${project.name}" from the MCPM registry. Project files were not changed.`
  ));
  return project;
}
