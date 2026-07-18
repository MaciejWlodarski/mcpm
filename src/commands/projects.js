import pc from 'picocolors';
import path from 'path';
import {
  findProjectRoot,
  forgetProject,
  listProjects,
  resolveProjectRoot,
  setActiveProject
} from '../projects.js';

export async function useCommand(reference) {
  const project = await setActiveProject(reference);
  console.log(pc.green(`Aktywny projekt MCPM: ${pc.bold(project.name)} (${project.path})`));
  const localRoot = await findProjectRoot();
  if (localRoot && localRoot !== project.path) {
    console.warn(pc.yellow(
      `Uwaga: w bieżącym katalogu pierwszeństwo ma lokalny projekt ${localRoot}. ` +
      'Przejdź poza niego, aby użyć projektu globalnie aktywnego.'
    ));
  }
  return project;
}

export async function currentCommand() {
  const projectRoot = await resolveProjectRoot();
  const registered = (await listProjects()).find(project => project.path === projectRoot);
  console.log(pc.green(
    `Bieżący projekt MCPM: ${pc.bold(registered?.name || path.basename(projectRoot))} (${projectRoot})`
  ));
  return { name: registered?.name || null, path: projectRoot };
}

export async function projectsCommand() {
  const projects = await listProjects();
  if (projects.length === 0) {
    console.log(pc.yellow('Brak zarejestrowanych projektów MCPM.'));
    return [];
  }

  console.log(pc.bold('Zarejestrowane projekty MCPM:'));
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    const marker = project.active ? pc.green('●') : ' ';
    const availability = project.available ? '' : pc.red(' (niedostępny)');
    console.log(`  ${marker} ${pc.cyan(project.name)}  ${project.path}${availability}`);
  }
  return projects;
}

export async function forgetCommand(reference) {
  const project = await forgetProject(reference);
  console.log(pc.green(
    `Usunięto projekt "${project.name}" z rejestru MCPM. Pliki projektu nie zostały zmienione.`
  ));
  return project;
}
