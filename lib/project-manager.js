const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

/**
 * Ensure the projects root directory exists.
 */
function ensureProjectsDir() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  }
}

/**
 * Create a new project with the given name and learning objective.
 * Returns the full project object.
 */
function createProject(name, learningObjective = '') {
  ensureProjectsDir();
  const id = uuidv4();
  const projectDir = path.join(PROJECTS_DIR, id);
  fs.mkdirSync(projectDir);
  fs.mkdirSync(path.join(projectDir, 'audio'));
  fs.mkdirSync(path.join(projectDir, 'video'));
  fs.mkdirSync(path.join(projectDir, 'output'));

  const project = {
    id,
    name,
    learningObjective,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    researchText: '',
    scenes: [],
    voiceProfileId: null,
    renderStatus: null, // null | 'rendering' | 'done' | 'error'
  };

  saveProject(id, project);
  return project;
}

/**
 * Save project data to disk as JSON.
 */
function saveProject(id, data) {
  ensureProjectsDir();
  const projectFile = path.join(PROJECTS_DIR, id, 'project.json');
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectFile, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Load a project by ID. Returns null if not found.
 */
function loadProject(id) {
  const projectFile = path.join(PROJECTS_DIR, id, 'project.json');
  if (!fs.existsSync(projectFile)) return null;
  const raw = fs.readFileSync(projectFile, 'utf-8');
  return JSON.parse(raw);
}

/**
 * List all projects (returns array of {id, name, createdAt, updatedAt}).
 */
function listProjects() {
  ensureProjectsDir();
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectFile = path.join(PROJECTS_DIR, entry.name, 'project.json');
    if (!fs.existsSync(projectFile)) continue;
    try {
      const raw = fs.readFileSync(projectFile, 'utf-8');
      const data = JSON.parse(raw);
      projects.push({
        id: data.id,
        name: data.name,
        learningObjective: data.learningObjective || '',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        sceneCount: (data.scenes || []).length,
        renderStatus: data.renderStatus,
      });
    } catch {
      // Skip corrupted project files
    }
  }
  // Sort by most recently updated
  projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return projects;
}

/**
 * Delete a project and all its assets.
 */
function deleteProject(id) {
  const projectDir = path.join(PROJECTS_DIR, id);
  if (!fs.existsSync(projectDir)) return false;
  fs.rmSync(projectDir, { recursive: true, force: true });
  return true;
}

/**
 * Get the absolute path to a project's subdirectory.
 */
function getProjectPath(id, ...subpath) {
  return path.join(PROJECTS_DIR, id, ...subpath);
}

module.exports = {
  createProject,
  saveProject,
  loadProject,
  listProjects,
  deleteProject,
  getProjectPath,
  PROJECTS_DIR,
};
