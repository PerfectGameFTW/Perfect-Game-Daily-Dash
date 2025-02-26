import { 
  Home,
  CircleDollarSign, 
  ShoppingBag, 
  Wallet, 
  MenuSquare
} from "lucide-react";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}

const NavItem = ({ icon, label, active }: NavItemProps) => {
  return (
    <div className="flex flex-col items-center justify-center w-1/5">
      <div className={`mb-0.5 ${active ? 'text-blue-500' : 'text-zinc-400'}`}>
        {icon}
      </div>
      <span className={`text-xs ${active ? 'text-blue-500 font-medium' : 'text-zinc-400'}`}>
        {label}
      </span>
    </div>
  );
};

const BottomNavigation = () => {
  return (
    <div className="fixed bottom-0 left-0 right-0 h-16 bg-black border-t border-zinc-800 flex items-center justify-between px-4">
      <NavItem 
        icon={<Home className="w-6 h-6" />} 
        label="Home" 
      />
      <NavItem 
        icon={<CircleDollarSign className="w-6 h-6" />} 
        label="Sales" 
        active 
      />
      <NavItem 
        icon={<ShoppingBag className="w-6 h-6" />} 
        label="Orders" 
      />
      <NavItem 
        icon={<Wallet className="w-6 h-6" />} 
        label="Banking" 
      />
      <NavItem 
        icon={<MenuSquare className="w-6 h-6" />} 
        label="Menu" 
      />
    </div>
  );
};

export default BottomNavigation;