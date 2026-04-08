// src/board.tsx - Agora TUI Dashboard
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { AgoraDB } from './db.js';
import type { Agent, Task } from './types.js';

interface BoardProps {
  dbPath?: string;
}

type View = 'list' | 'detail';

const STATUS_COLORS: Record<string, string> = {
  completed: 'green',
  in_progress: 'yellow',
  assigned: 'cyan',
  pending: 'white',
  failed: 'red',
  timed_out: 'red',
  cancelled: 'gray',
};

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

export function Board({ dbPath }: BoardProps) {
  const { exit } = useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState({ active: 0, inactive: 0, avgTasksCompleted: 0 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<View>('list');

  // Open DB read-only (WAL mode allows concurrent reads)
  const db = React.useMemo(() => new AgoraDB(dbPath), [dbPath]);

  const refresh = () => {
    setAgents(db.listAgents({ status: 'all' }));
    setTasks(db.getRecentTasks(20));
    setStats(db.getAgentStats());
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => {
      clearInterval(interval);
      db.close();
    };
  }, []);

  useInput((input, key) => {
    if (view === 'detail') {
      if (key.escape || input === 'q' || input === 'b') {
        setView('list');
      }
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(tasks.length - 1, i + 1));
    }
    if (key.return && tasks.length > 0) {
      setView('detail');
    }
  });

  const selectedTask = tasks[selectedIndex];

  if (view === 'detail' && selectedTask) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Task Detail — {selectedTask.task_id.slice(0, 8)}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text><Text bold>Status: </Text><Text color={STATUS_COLORS[selectedTask.status] ?? 'white'}>{selectedTask.status.toUpperCase()}</Text></Text>
          <Text><Text bold>Description: </Text>{selectedTask.description}</Text>
          {selectedTask.assigned_agent_name && (
            <Text><Text bold>Agent: </Text>{selectedTask.assigned_agent_name}</Text>
          )}
          {selectedTask.progress !== undefined && (
            <Text><Text bold>Progress: </Text>{selectedTask.progress}%</Text>
          )}
          {selectedTask.input && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Input:</Text>
              <Text>{JSON.stringify(selectedTask.input, null, 2)}</Text>
            </Box>
          )}
          {selectedTask.output && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Output:</Text>
              <Text>{JSON.stringify(selectedTask.output, null, 2)}</Text>
            </Box>
          )}
          {selectedTask.error && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="red">Error:</Text>
              <Text>{selectedTask.error.message}</Text>
            </Box>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[Esc/B] Back  [Q] Quit</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="cyan">Agora Hub Dashboard</Text>
        <Text dimColor>  {new Date().toLocaleTimeString()}</Text>
      </Box>

      {/* Agents section */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text bold>Agents  </Text>
        <Text dimColor>Active: {stats.active}  Inactive: {stats.inactive}  Avg completed: {stats.avgTasksCompleted.toFixed(1)}</Text>
        {agents.slice(0, 5).map((agent) => (
          <Box key={agent.agent_id}>
            <Text color={agent.status === 'active' ? 'green' : 'gray'}>
              {agent.status === 'active' ? '●' : '○'}{' '}
            </Text>
            <Text>{truncate(agent.name, 16).padEnd(16)} </Text>
            <Text dimColor color={agent.status === 'active' ? undefined : 'gray'}>
              {formatAge(agent.last_seen_at)}
            </Text>
          </Box>
        ))}
        {agents.length === 0 && <Text dimColor>  No agents registered</Text>}
      </Box>

      {/* Tasks section */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text bold>Recent Tasks</Text>
        <Box>
          <Text dimColor>{'ID      '.padEnd(8)}</Text>
          <Text dimColor>{'STATUS      '.padEnd(12)}</Text>
          <Text dimColor>{'AGENT           '.padEnd(16)}</Text>
          <Text dimColor>DESCRIPTION</Text>
        </Box>
        {tasks.map((task, i) => {
          const isSelected = i === selectedIndex;
          const color = STATUS_COLORS[task.status] ?? 'white';
          return (
            <Box key={task.task_id}>
              <Text backgroundColor={isSelected ? 'blue' : undefined}>
                <Text>{isSelected ? '▶ ' : '  '}</Text>
                <Text>{task.task_id.slice(0, 6).padEnd(8)}</Text>
                <Text color={color}>{task.status.toUpperCase().padEnd(12)}</Text>
                <Text>{truncate(task.assigned_agent_name ?? '-', 14).padEnd(16)}</Text>
                <Text>{truncate(task.description, 40)}</Text>
              </Text>
            </Box>
          );
        })}
        {tasks.length === 0 && <Text dimColor>  No tasks yet</Text>}
      </Box>

      {/* Footer */}
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>[↑/↓] Select  [Enter] Detail  [Q] Quit</Text>
      </Box>
    </Box>
  );
}
