// User Menu component
"use client";

import { useAuth } from "@/context/AuthContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, User } from "lucide-react";
import { LogoutButton } from "./LogoutButton";

export const UserMenu = () => {
  const { user, isAuthenticated } = useAuth();

  // If not authenticated, don't show anything
  if (!isAuthenticated || !user) {
    return null;
  }

  // Get initials from username for the avatar
  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="focus:outline-none">
        <Avatar className="cursor-pointer">
          <AvatarFallback>{getInitials(user.username)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <User className="h-4 w-4" />
          <span>{user.username}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer" asChild>
          <LogoutButton variant="ghost" size="sm" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};