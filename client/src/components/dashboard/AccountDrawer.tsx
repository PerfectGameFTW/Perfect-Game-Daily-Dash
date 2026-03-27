import { useEffect } from "react";
import { 
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { ShieldCheck, User, LogOut, CreditCard, CircleCheck, Moon, Sun } from "lucide-react";
import { useLocation } from "wouter";

interface AccountDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AccountDrawer({ open, onOpenChange }: AccountDrawerProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [_, navigate] = useLocation();

  const handleNavigate = (path: string) => {
    navigate(path);
    onOpenChange(false);
  };

  const handleLogout = () => {
    logout();
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="bg-background/95 backdrop-blur-sm border-t border-t-border">
        <div className="mx-auto w-full max-w-sm">
          <DrawerHeader>
            <DrawerTitle className="text-foreground text-center">Account</DrawerTitle>
            <DrawerDescription className="text-muted-foreground text-center">
              {user ? `Logged in as ${user.username}` : 'Manage your account'}
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 py-2 pb-6 space-y-4">
            {user?.role === 'admin' && (
              <Button 
                variant="outline" 
                className="w-full text-left justify-start gap-2 border-border hover:bg-accent/50"
                onClick={() => handleNavigate('/admin')}
              >
                <ShieldCheck className="h-5 w-5 text-primary" />
                Users
              </Button>
            )}
            <Button 
              variant="outline" 
              className="w-full text-left justify-start gap-2 border-border hover:bg-accent/50"
              onClick={handleLogout}
            >
              <LogOut className="h-5 w-5 text-primary" />
              Sign out
            </Button>
            
            {/* Dark Mode Toggle */}
            <div className="flex items-center justify-between px-2 py-3 border border-border rounded-md">
              <div className="flex items-center gap-2">
                {theme === 'dark' ? (
                  <Moon className="h-5 w-5 text-primary" />
                ) : (
                  <Sun className="h-5 w-5 text-primary" />
                )}
                <span className="text-foreground">{theme === 'dark' ? 'Dark' : 'Light'} Mode</span>
              </div>
              <Switch 
                checked={theme === 'dark'}
                onCheckedChange={toggleTheme}
              />
            </div>
          </div>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline" className="border-border hover:bg-accent/50">
                Close
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}