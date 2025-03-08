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
import { useAuth } from "@/context/AuthContext";
import { ShieldCheck, User, LogOut } from "lucide-react";
import { useLocation } from "wouter";

interface AccountDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AccountDrawer({ open, onOpenChange }: AccountDrawerProps) {
  const { user, logout } = useAuth();
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
      <DrawerContent className="bg-black/95 backdrop-blur-sm border-t border-white/10">
        <div className="mx-auto w-full max-w-sm">
          <DrawerHeader>
            <DrawerTitle className="text-white text-center">Account</DrawerTitle>
            <DrawerDescription className="text-white/70 text-center">
              {user ? `Logged in as ${user.username}` : 'Manage your account'}
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 py-2 pb-6 space-y-4">
            {user?.role === 'admin' && (
              <Button 
                variant="outline" 
                className="w-full text-left justify-start gap-2 border-white/20 hover:bg-white/10"
                onClick={() => handleNavigate('/admin')}
              >
                <ShieldCheck className="h-5 w-5 text-primary" />
                Admin Dashboard
              </Button>
            )}
            <Button 
              variant="outline" 
              className="w-full text-left justify-start gap-2 border-white/20 hover:bg-white/10"
              onClick={() => handleNavigate('/')}
            >
              <User className="h-5 w-5 text-primary" />
              Dashboard
            </Button>
            <Button 
              variant="outline" 
              className="w-full text-left justify-start gap-2 border-white/20 hover:bg-white/10"
              onClick={handleLogout}
            >
              <LogOut className="h-5 w-5 text-primary" />
              Sign out
            </Button>
          </div>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline" className="border-white/20 hover:bg-white/10">
                Close
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}