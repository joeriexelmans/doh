
# Dependency-aware Operation History
... or **Doh** for short (pronounced "dough" or "D'OH!" - see illustration below) is a **distributed, operation-based, dependency-aware version control system (VCS)**.
![D'oh!](homer.jpg)

## Goals
The intention of Doh was to create an operation-based versioning system, not for "text", but for graphs.

### Why graphs?
Because they are a much more suitable foundation for reasoning about (visual) models (e.g. Statecharts), both at the concrete and abstract syntax levels, which is our main goal. Furthermore, "text" can be represented as a graph as well, more precisely as a linked list of lines, words, characters or "hunks", which is how some CRDTs do it.

### Why operation-based?
There are a number of reasons. In no particular order:
* A history of operations contains more information than a history of snapshots. This information can be used by algorithms for better diffing, merging, conflict detection and resolution.
* Lightweight and simple: Edit operations can be described with relatively little information. In contrast to state-based VCS, diffs between versions (needed for version comparison, merging and compression purposes) do not have to be computed; they are already known.
* Many editors already log users' edit operations, disguised under the functionality of "undo & redo". Sadly, most of these editors can only persist a single snapshot of their state when "saving": the undo history is lost after a restart. A side-effect of operation-based versioning is a persistent undo history.
* The only efficient and reliable way to enable "synchronous collaboration" (i.e. everyone immediately sees everyone's changes, like in Google Docs), is to somehow serialize, broadcast and persist users' edit operations. Moreover, synchronous collaboration only needs to be implemented once, in the versioning system instead of in the editor. Any editor integrating with such a versioning system will get synchronous collaboration, "for free".

The main drawback of the operation-based approach, is the repeated, ad-hoc and sometimes complex effort of editor integration. Pragmatism is our enemy here, and my hope is that at some point, some operation-based VCS with enough traction will define an open (e.g. socket-based) API, to be implemented by developers of editors, who are best positioned to do the VCS integration.

## Non-exhaustive list of things that inspired me
"Nothing is original." - Jim Jarmusch
* Git (Linus Torvalds)
* CRDTs (??)
* The ModelVerse (Yentl Van Tendeloo and Hans Vangheluwe): graphs and a primitive set of graph operations are the most generic way of storing and transforming "models"
* The paper "Enhancing Collaborative Modeling" (Jakob Pietron) which sparked my interest in model versioning

## Comparison with Git
The easiest way (for me) to explain Doh, is to compare it with Git. Back when I conceived Doh, Git was the versioning system I was most familiar with, and also found it beautiful from a theoretical perspective. 
| |Git|Doh|
|--|--|--|
|Distributed|Yes|Yes|
|History forms a...|Directed acyclic graph|Directed acyclic graph|
|Supported collaboration modes|Asynchronous|Synchronous & asynchronous|
|What is being versioned?|A filesystem hierarchy, i.e. directories and files, mostly containing "text"|A key → value mapping|
|How are versions created?|Manually with the "commit" command. (Works with any editor that can save its state to a file.)|Automatically, for every edit operation. (Therefore requires non-trivial editor integration.)|
|What is recorded with every version?|A snapshot of a filesystem hierarchy|A set of key → value assignments|
|How are versions linked?|"parent" relation: the immediate previous version(s) in logical time|"dependencies": the ancestor version(s) that are at least partially overwritten
|HEAD points to a|Single version|Set of independent, non-conflicting operations (= set of versions)|
|What's the result of a merge?|A new version, with as parents the merged versions|An update to HEAD, being the union of the merged HEADs
|Conflict resolution|Manually specify what the merged version must look like|Destructive: manually or randomly pick an operation to be excluded from HEAD. (The excluded operation becomes an abandoned branch.)|
|Version IDs|Content-addressed (SHA-1)|GUIDs (I want to change this to content-addressed at some point)