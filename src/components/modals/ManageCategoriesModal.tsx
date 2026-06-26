import Modal from '../Modal'
import CustomCategoriesList from '../CustomCategoriesList'

export default function ManageCategoriesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Manage categories">
      <CustomCategoriesList onClose={onClose} />
    </Modal>
  )
}
