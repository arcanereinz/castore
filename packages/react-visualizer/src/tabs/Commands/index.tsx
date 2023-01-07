import { Stack } from '@mui/material';
import React from 'react';

import type { EventStore } from '@castore/core';
import type { JSONSchemaCommand } from '@castore/json-schema-command';

import { CommandCard } from './CommandCard';

export const Commands = ({
  commands,
  eventStoresById,
  contextsByCommandId,
}: {
  commands: JSONSchemaCommand[];
  eventStoresById: Record<string, EventStore>;
  contextsByCommandId: Record<string, unknown[]>;
}): JSX.Element => (
  <Stack spacing={2}>
    {commands.map(command => (
      <CommandCard
        key={command.commandId}
        command={command}
        eventStoresById={eventStoresById}
        contextsByCommandId={contextsByCommandId}
      />
    ))}
  </Stack>
);
