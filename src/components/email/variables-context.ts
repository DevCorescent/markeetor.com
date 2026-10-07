'use client';
import { createContext, useContext } from 'react';
import { VARIABLES, type VariableDef } from '@/lib/email/types';

/** The {{variables}} offered by the editor's insert menus. The welcome email adds account details to the defaults. */
export const EmailVariablesContext = createContext<readonly VariableDef[]>(VARIABLES);
export const useEmailVariables = () => useContext(EmailVariablesContext);
