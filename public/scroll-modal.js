// Scroll the modal body
const modalBody = document.querySelector('#theme-customizer-modal .modal-body');
if (modalBody) {
  modalBody.scrollTop = modalBody.scrollHeight;
  console.log('Scrolled modal body to bottom, scrollHeight:', modalBody.scrollHeight);
}
